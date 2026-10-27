import {
  collectPlaceholders,
  verifyPlaceholders,
  verifyPlaceholderTokens,
  stripPlaceholders,
  judgeTranslation,
} from "./placeholderGuard";

const RE = /\{\d+\}/g;

describe("collectPlaceholders", () => {
  test("统计 token 次数且不重叠", () => {
    const counts = collectPlaceholders("a {1} b {2} c {1}", RE);
    expect(counts.get("{1}")).toBe(2);
    expect(counts.get("{2}")).toBe(1);
  });

  test("空文本返回空 Map", () => {
    expect(collectPlaceholders("", RE).size).toBe(0);
    expect(collectPlaceholders(null, RE).size).toBe(0);
  });
});

describe("verifyPlaceholders", () => {
  test("全部保留且各一次 → ok", () => {
    const r = verifyPlaceholders("x {1} y {2}", "[中文] x {1} y {2}", RE);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test("丢失占位符 → missing", () => {
    const r = verifyPlaceholders("x {1} y {2}", "[中文] x y {2}", RE);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["{1}"]);
  });

  test("重复占位符 → duplicated", () => {
    const r = verifyPlaceholders("x {1}", "{1} x {1}", RE);
    expect(r.ok).toBe(false);
    expect(r.duplicated).toEqual(["{1}"]);
  });

  test("模型臆造占位符 → unexpected", () => {
    const r = verifyPlaceholders("x {1}", "x {1} {9}", RE);
    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual(["{9}"]);
  });
});

describe("stripPlaceholders", () => {
  test("清掉所有 token 但保留正文", () => {
    expect(stripPlaceholders("a {1} b {2} c", RE)).toBe("a  b  c");
  });
});

describe("judgeTranslation", () => {
  test("正常译文通过", () => {
    expect(judgeTranslation("Hello world", "你好世界").ok).toBe(true);
  });

  test("空译文判失败", () => {
    expect(judgeTranslation("Hello", "").reason).toBe("empty");
  });

  test("与原文相同判失败", () => {
    expect(judgeTranslation("Hello", "Hello").reason).toBe("same-as-source");
  });

  test("长度比异常判失败", () => {
    expect(judgeTranslation("Hello world", "好", { minRatio: 0.2 }).reason).toBe("too-short");
  });
});

describe("verifyPlaceholderTokens", () => {
  test("期望 token 全部出现一次 → ok", () => {
    expect(verifyPlaceholderTokens(["{1}", "{2}"], "a {1} b {2}", RE).ok).toBe(true);
  });

  test("缺 token → missing", () => {
    const r = verifyPlaceholderTokens(["{1}"], "a b", RE);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["{1}"]);
  });

  test("重复 token → duplicated", () => {
    const r = verifyPlaceholderTokens(["{1}"], "{1} a {1}", RE);
    expect(r.ok).toBe(false);
    expect(r.duplicated).toEqual(["{1}"]);
  });
});
