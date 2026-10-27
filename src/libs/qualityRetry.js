/**
 * 译文质量校验与重试阶梯
 *
 * 批量翻译一次返回多段译文，模型偶尔会漏段、回空、把原文原样吐回、或给出
 * 长度比例异常的碎片。这里在批量请求结束后逐段判定，把不合格的段落按
 * 「小批重试 → 单段重试」逐级收敛：
 *
 *   1. 初次批量结果 → 逐段 judgeTranslation；
 *   2. 失败段合并成一次小批请求（仍是同一条服务链路，只是段数更少）；
 *   3. 仍失败段逐段单独重试（隔离上下文，最贵但成功率最高）；
 *   4. 仍未解决的段保留「最有内容」的候选并上报 id，由上层决定是否标记。
 *
 * 判定与请求解耦：request(ids) 由调用方注入，返回 [{id, result}]，
 * 这样质量阶梯可以独立测试，也不绑定具体服务实现。
 */
import { judgeTranslation } from "./placeholderGuard";

/** 从 [译文, 源语言] 或裸字符串里取出译文正文 */
export const extractTranslatedText = (translation) => {
  if (Array.isArray(translation)) return String(translation[0] ?? "");
  return String(translation ?? "");
};

/**
 * 只有句子级的源文本才值得做「同文/长度比」判定。
 * 短标签、专名、纯数字、纯符号（如 "2024"、"DeepSeek"、"100%"）本来就可能
 * 原样返回，若也触发重试，会给每批都白烧一到两次请求。
 * 空译不受此限制：任何段落回空都算失败。
 */
export const shouldJudgeQuality = (sourceText) => {
  const source = String(sourceText ?? "").trim();
  if (!/\p{L}{2,}/u.test(source)) return false;
  const words = source.split(/\s+/).filter(Boolean);
  return words.length >= 3 || source.length >= 12;
};

/** 在 judgeTranslation 之上叠加「不值得判定的源文本直接放行」 */
export const judgeTranslatedText = (
  sourceText,
  translatedText,
  judgeOptions
) => {
  const verdict = judgeTranslation(sourceText, translatedText, judgeOptions);
  if (
    !verdict.ok &&
    verdict.reason !== "empty" &&
    !shouldJudgeQuality(sourceText)
  ) {
    return { ...verdict, ok: true, reason: "", skipped: true };
  }
  if (
    !verdict.ok &&
    verdict.reason === "same-as-source" &&
    !shouldJudgeSameAsSource(sourceText)
  ) {
    return { ...verdict, ok: true, reason: "", skipped: true };
  }
  return verdict;
};

/**
 * 「原样返回」只有在源文本像句子时才算失败。
 * 多词专名（`Tom & Jerry`、`Visual Studio Code`）模型本就会保留原文，若也判同文，
 * 每次都会白烧一次小批重试并给译文挂上质量角标。
 * 判据：≥4 词、含小写开头的词（真正的句子通常有功能词），或含中日韩文字。
 */
export const shouldJudgeSameAsSource = (sourceText) => {
  const source = String(sourceText ?? "").trim();
  if (!shouldJudgeQuality(source)) return false;
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(source)) return true;
  const tokens = source.split(/\s+/).filter(Boolean);
  if (tokens.length >= 4) return true;
  return tokens.some((token) => /^[a-z]/.test(token));
};

/**
 * 对一批译文逐段判定。
 * @returns {{accepted: Array, failed: Array<{chunk:Object, verdict:Object}>}}
 */
export const judgeTranslationChunks = (texts, chunks, judgeOptions) => {
  const accepted = [];
  const failed = [];
  for (const chunk of chunks || []) {
    const source = texts[chunk?.id] ?? "";
    const verdict = judgeTranslatedText(
      source,
      extractTranslatedText(chunk?.result),
      judgeOptions
    );
    if (verdict.ok) accepted.push(chunk);
    else failed.push({ chunk, verdict });
  }
  return { accepted, failed };
};

/**
 * 候选优劣评分：用于重试仍不合格时保留哪一版。
 * 合格 > 长度异常但非空 > 原文原样 > 空译；缺失视为最低。
 */
const scoreCandidate = (texts, id, chunk, judgeOptions) => {
  if (!chunk) return -1;
  const verdict = judgeTranslatedText(
    texts[id] ?? "",
    extractTranslatedText(chunk.result),
    judgeOptions
  );
  if (verdict.ok) return 3;
  if (verdict.reason === "same-as-source") return 1;
  if (verdict.reason === "empty") return 0;
  return 2;
};

/**
 * 执行质量重试阶梯。
 *
 * @param {string[]} texts 本批的源文本（按 id 索引）
 * @param {Array<{id:number, result:(string|string[])}>} chunks 初次批量结果
 * @param {(ids:number[]) => Promise<Array>} request 重试请求器，入参为原始 id 列表
 * @param {Object} [options]
 * @param {Object} [options.judgeOptions] judgeTranslation 的阈值覆盖
 * @param {number} [options.maxBatchPasses=1] 小批重试轮数
 * @param {number} [options.maxItemPasses=1] 单段重试轮数
 * @param {boolean} [options.skipItemOnNoGain=true] 小批重试毫无改善时跳过单段重试
 * @param {(attempt:Object)=>void} [options.onAttempt] 每次重试后的观测回调
 * @returns {Promise<{chunks:Array, unresolvedIds:number[]}>}
 */
export const runQualityRetryLadder = async ({
  texts,
  chunks,
  request,
  judgeOptions,
  maxBatchPasses = 1,
  maxItemPasses = 1,
  skipItemOnNoGain = true,
  onAttempt,
}) => {
  const total = texts?.length || 0;
  const candidates = new Map();
  for (const chunk of chunks || []) {
    const id = chunk?.id;
    if (Number.isInteger(id) && id >= 0 && id < total) {
      candidates.set(id, chunk);
    }
  }

  const isAcceptable = (id) =>
    scoreCandidate(texts, id, candidates.get(id), judgeOptions) === 3;

  const pendingIds = () => {
    const ids = [];
    for (let id = 0; id < total; id++) {
      if (!isAcceptable(id)) ids.push(id);
    }
    return ids;
  };

  const applyRetry = async (ids, stage) => {
    if (typeof request !== "function") return 0;
    let retried = [];
    try {
      retried = (await request(ids)) || [];
    } catch (error) {
      // 重试链路自身失败（断网/取消除外）不能拖垮已经拿到的首轮译文
      if (error?.name === "AbortError") throw error;
      onAttempt?.({ stage, ids, results: 0, error });
      return 0;
    }
    let changed = 0;
    for (const chunk of retried) {
      const id = chunk?.id;
      if (!Number.isInteger(id) || !ids.includes(id)) continue;
      const previous = candidates.get(id);
      if (
        scoreCandidate(texts, id, chunk, judgeOptions) >
        scoreCandidate(texts, id, previous, judgeOptions)
      ) {
        candidates.set(id, chunk);
        changed++;
      }
    }
    onAttempt?.({ stage, ids, results: retried.length, changed });
    return changed;
  };

  let pending = pendingIds();
  let batchAttempted = false;
  let batchImproved = false;

  // 阶段 1：失败段合并成一次小批重试
  for (let pass = 0; pass < maxBatchPasses && pending.length; pass++) {
    batchAttempted = true;
    const changed = await applyRetry(pending, "batch");
    if (changed > 0) batchImproved = true;
    pending = pendingIds();
  }

  // 阶段 2：逐段单独重试，隔离上下文，避免再次被同批其它段带偏。
  // 小批重试毫无改善时（专名原样返回、服务端持续异常）默认跳过单段重试：
  // 逐段再发一轮请求成功率极低，却会把整页请求数放大到 N 级。
  const skipItemStage = skipItemOnNoGain && batchAttempted && !batchImproved;
  if (!skipItemStage) {
    for (let pass = 0; pass < maxItemPasses && pending.length; pass++) {
      const stillBad = [];
      for (const id of pending) {
        await applyRetry([id], "item");
        if (!isAcceptable(id)) stillBad.push(id);
      }
      pending = stillBad;
    }
  }

  const ordered = [];
  for (let id = 0; id < total; id++) {
    const chunk = candidates.get(id);
    if (chunk) ordered.push(chunk);
  }
  return { chunks: ordered, unresolvedIds: pending };
};
