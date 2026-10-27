import {
  extractTranslatedText,
  judgeTranslatedText,
  judgeTranslationChunks,
  runQualityRetryLadder,
  shouldJudgeQuality,
  shouldJudgeSameAsSource,
} from "./qualityRetry";

const texts = [
  "Hello world",
  "Second paragraph",
  "This is the third paragraph.",
];

describe("extractTranslatedText", () => {
  test("数组形态取第一项译文", () => {
    expect(extractTranslatedText(["你好世界", "en"])).toBe("你好世界");
  });

  test("裸字符串原样返回，空值归一为空串", () => {
    expect(extractTranslatedText("你好")).toBe("你好");
    expect(extractTranslatedText(undefined)).toBe("");
    expect(extractTranslatedText([null, "en"])).toBe("");
  });
});

describe("shouldJudgeQuality", () => {
  test("句子级文本参与判定", () => {
    expect(shouldJudgeQuality("This is the third paragraph.")).toBe(true);
    expect(shouldJudgeQuality("这是一个需要翻译的完整句子")).toBe(true);
  });

  test("短标签、专名、数字、符号不参与同文判定", () => {
    expect(shouldJudgeQuality("2024")).toBe(false);
    expect(shouldJudgeQuality("DeepSeek")).toBe(false);
    expect(shouldJudgeQuality("100%")).toBe(false);
    expect(shouldJudgeQuality("OK")).toBe(false);
    expect(shouldJudgeQuality("Third one")).toBe(false);
  });

  test("空译任何源文本都照常判失败", () => {
    expect(judgeTranslatedText("2024", "").ok).toBe(false);
    expect(judgeTranslatedText("2024", "").reason).toBe("empty");
  });

  test("不值得判定的段落同文放行，句子同文仍判失败", () => {
    expect(judgeTranslatedText("2024", "2024").ok).toBe(true);
    expect(
      judgeTranslatedText(
        "This is the third paragraph.",
        "This is the third paragraph."
      ).ok
    ).toBe(false);
  });
});

describe("shouldJudgeSameAsSource", () => {
  test("多词专名原样返回不判失败", () => {
    expect(shouldJudgeSameAsSource("Tom & Jerry")).toBe(false);
    expect(shouldJudgeSameAsSource("Visual Studio Code")).toBe(false);
    expect(judgeTranslatedText("Tom & Jerry", "Tom & Jerry").ok).toBe(true);
    expect(
      judgeTranslatedText("Visual Studio Code", "Visual Studio Code").ok
    ).toBe(true);
  });

  test("句子原样返回仍判失败", () => {
    expect(shouldJudgeSameAsSource("This is the third paragraph.")).toBe(true);
    expect(
      judgeTranslatedText(
        "This is the third paragraph.",
        "This is the third paragraph."
      ).ok
    ).toBe(false);
  });

  test("中文同文仍判失败", () => {
    expect(shouldJudgeSameAsSource("这是一个需要翻译的完整句子")).toBe(true);
    expect(
      judgeTranslatedText(
        "这是一个需要翻译的完整句子",
        "这是一个需要翻译的完整句子"
      ).ok
    ).toBe(false);
  });
});

describe("judgeTranslationChunks", () => {
  test("按 id 对上源文本做判定", () => {
    const { accepted, failed } = judgeTranslationChunks(texts, [
      { id: 0, result: ["你好世界", ""] },
      { id: 1, result: ["", ""] },
      { id: 2, result: ["This is the third paragraph.", ""] },
    ]);
    expect(accepted.map((c) => c.id)).toEqual([0]);
    expect(failed.map((f) => [f.chunk.id, f.verdict.reason])).toEqual([
      [1, "empty"],
      [2, "same-as-source"],
    ]);
  });
});

describe("runQualityRetryLadder", () => {
  test("全部合格时不发任何重试请求", async () => {
    const request = jest.fn();
    const { chunks, unresolvedIds } = await runQualityRetryLadder({
      texts,
      chunks: [
        { id: 0, result: ["你好世界", ""] },
        { id: 1, result: ["第二段", ""] },
        { id: 2, result: ["第三段", ""] },
      ],
      request,
    });
    expect(request).not.toHaveBeenCalled();
    expect(chunks.map((c) => c.id)).toEqual([0, 1, 2]);
    expect(unresolvedIds).toEqual([]);
  });

  test("空译先合并小批重试，成功后不再单段重试", async () => {
    const request = jest.fn(async (ids) =>
      ids.map((id) => ({ id, result: ["重试译文" + id, ""] }))
    );
    const { chunks, unresolvedIds } = await runQualityRetryLadder({
      texts,
      chunks: [
        { id: 0, result: ["", ""] },
        { id: 1, result: ["", ""] },
        { id: 2, result: ["第三段", ""] },
      ],
      request,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual([0, 1]);
    expect(chunks.map((c) => extractTranslatedText(c.result))).toEqual([
      "重试译文0",
      "重试译文1",
      "第三段",
    ]);
    expect(unresolvedIds).toEqual([]);
  });

  test("小批重试仍失败时逐段重试，并把最终未解决段报出来", async () => {
    const request = jest.fn(async (ids) =>
      ids.map((id) =>
        id === 1
          ? { id, result: ["", ""] }
          : { id, result: ["好译文" + id, ""] }
      )
    );
    const { chunks, unresolvedIds } = await runQualityRetryLadder({
      texts,
      chunks: [
        { id: 0, result: ["", ""] },
        { id: 1, result: ["", ""] },
        { id: 2, result: ["第三段", ""] },
      ],
      request,
    });
    // 一次小批（0,1）+ 对仍失败的 1 做一次单段重试
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toEqual([1]);
    expect(unresolvedIds).toEqual([1]);
    expect(chunks.find((c) => c.id === 0).result[0]).toBe("好译文0");
  });

  test("首轮缺失的段也进入重试，并保持 id 顺序", async () => {
    const request = jest.fn(async (ids) =>
      ids.map((id) => ({ id, result: ["补译" + id, ""] }))
    );
    const { chunks } = await runQualityRetryLadder({
      texts,
      chunks: [{ id: 2, result: ["第三段", ""] }],
      request,
    });
    expect(request.mock.calls[0][0]).toEqual([0, 1]);
    expect(chunks.map((c) => c.id)).toEqual([0, 1, 2]);
  });

  test("重试请求自身抛错时保留首轮结果，不拖垮整批", async () => {
    const request = jest.fn(async () => {
      throw new Error("network down");
    });
    const onAttempt = jest.fn();
    const { chunks, unresolvedIds } = await runQualityRetryLadder({
      texts,
      chunks: [
        { id: 0, result: ["你好世界", ""] },
        { id: 1, result: ["", ""] },
      ],
      request,
      onAttempt,
    });
    expect(chunks.map((c) => c.id)).toEqual([0, 1]);
    expect(unresolvedIds).toEqual([1, 2]);
    expect(onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "batch", results: 0 })
    );
  });

  test("小批重试毫无改善时不再逐段放大请求", async () => {
    const request = jest.fn(async (ids) =>
      ids.map((id) => ({ id, result: ["", ""] }))
    );
    const { unresolvedIds } = await runQualityRetryLadder({
      texts,
      chunks: [
        { id: 0, result: ["", ""] },
        { id: 1, result: ["", ""] },
        { id: 2, result: ["第三段", ""] },
      ],
      request,
    });
    // 只发一次小批重试；逐段重试的收益为零，默认跳过以免整页请求数放大到 N 级
    expect(request).toHaveBeenCalledTimes(1);
    expect(unresolvedIds).toEqual([0, 1]);
  });

  test("小批重试有改善时仍继续逐段重试", async () => {
    const request = jest.fn(async (ids) =>
      ids.map((id) => (id === 0 ? { id, result: ["补译", ""] } : { id, result: ["", ""] }))
    );
    const { unresolvedIds } = await runQualityRetryLadder({
      texts,
      chunks: [
        { id: 0, result: ["", ""] },
        { id: 1, result: ["", ""] },
        { id: 2, result: ["第三段", ""] },
      ],
      request,
    });
    expect(request.mock.calls[1][0]).toEqual([1]);
    expect(unresolvedIds).toEqual([1]);
  });

  test("重试结果不覆盖已合格的候选", async () => {
    const request = jest.fn(async (ids) =>
      ids.map((id) => ({ id, result: ["", ""] }))
    );
    const { chunks, unresolvedIds } = await runQualityRetryLadder({
      texts,
      chunks: [{ id: 0, result: ["你好世界", ""] }],
      request,
      maxItemPasses: 0,
    });
    expect(chunks[0].result[0]).toBe("你好世界");
    expect(unresolvedIds).toEqual([1, 2]);
  });
});
