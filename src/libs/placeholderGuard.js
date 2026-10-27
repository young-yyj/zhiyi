/**
 * 占位符守恒校验（纯函数，供 translator 与测试共用）
 *
 * 背景：页面翻译时行内标签/空白会先被序列化成占位符（如 `{1}`、`<a1>`），
 * 模型返回的译文必须原样带上这些占位符，否则还原后会出现「链接丢失」或
 * 正文里残留 `{1}` 这类可见垃圾。本模块提供计数、校验与清理能力。
 */

const ensureGlobal = (regex) =>
  regex instanceof RegExp && regex.flags.includes("g")
    ? regex
    : new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");

/** 统计文本中每个占位符 token 的出现次数（token -> count） */
export const collectPlaceholders = (text, regex) => {
  const counts = new Map();
  const source = String(text ?? "");
  if (!source) return counts;
  for (const match of source.matchAll(ensureGlobal(regex))) {
    counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  }
  return counts;
};

/**
 * 校验译文是否守恒：源里的占位符必须全部出现且只出现一次。
 * @returns {{ok:boolean, missing:string[], duplicated:string[], unexpected:string[], expected:string[]}}
 */
export const verifyPlaceholders = (sourceText, translatedText, regex) => {
  const expected = collectPlaceholders(sourceText, regex);
  const actual = collectPlaceholders(translatedText, regex);
  const missing = [];
  const duplicated = [];
  const unexpected = [];

  for (const [token, count] of expected) {
    const got = actual.get(token) || 0;
    if (got === 0) missing.push(token);
    else if (got > 1 || got !== count) duplicated.push(token);
  }
  for (const token of actual.keys()) {
    if (!expected.has(token)) unexpected.push(token);
  }

  return {
    ok: missing.length === 0 && duplicated.length === 0 && unexpected.length === 0,
    missing,
    duplicated,
    unexpected,
    expected: Array.from(expected.keys()),
  };
};

/**
 * 以「期望 token 列表」为准做守恒校验（translator 还原阶段使用）。
 * 期望 token 来自序列化时生成的 placeholderMap 键；译文里必须每个出现一次。
 */
export const verifyPlaceholderTokens = (expectedTokens, translatedText, regex) => {
  const counts = collectPlaceholders(translatedText, regex);
  const missing = [];
  const duplicated = [];
  for (const token of expectedTokens || []) {
    const got = counts.get(token) || 0;
    if (got === 0) missing.push(token);
    else if (got > 1) duplicated.push(token);
  }
  return { ok: missing.length === 0 && duplicated.length === 0, missing, duplicated };
};

/**
 * 去掉文本中所有占位符 token。
 * 用于模型违约时的降级：宁可丢格式，也不能让 `{1}` 之类残留在正文里。
 */
export const stripPlaceholders = (text, regex) =>
  String(text ?? "").replace(ensureGlobal(regex), "");

/** 粗略判断译文是否可用（空 / 与原文完全相同 / 长度比异常） */
export const judgeTranslation = (sourceText, translatedText, { minRatio = 0.05, maxRatio = 20 } = {}) => {
  const src = String(sourceText ?? "").trim();
  const out = String(translatedText ?? "").trim();
  if (!out) return { ok: false, reason: "empty" };
  if (out === src) return { ok: false, reason: "same-as-source" };
  const ratio = src.length === 0 ? Infinity : out.length / src.length;
  if (ratio < minRatio) return { ok: false, reason: "too-short", ratio };
  if (ratio > maxRatio) return { ok: false, reason: "too-long", ratio };
  return { ok: true, reason: "", ratio };
};
