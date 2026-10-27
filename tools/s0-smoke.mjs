/**
 * S0 冒烟测试（直连 DeepSeek API，不经过扩展）
 *
 * 目的：验证真实链路的三件事
 *  1. 模型可用性与真实时延（含 KV 缓存命中情况）
 *  2. thinking:{type:"disabled"} 是否真的不产生思维链
 *  3. 批量 JSON 协议（Kiss 原生 batch-translation-json 同构）下的 id 对齐与行内占位符保真
 *
 * 用法：node tools/s0-smoke.mjs
 * Key 从环境变量读取，永不打印：$DSH_SECRET_DEEPSEEK_API_KEY
 */

const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = process.env.S0_MODEL || "deepseek-flash";
const KEY = process.env.DSH_SECRET_DEEPSEEK_API_KEY;

if (!KEY) {
  console.error("ERROR: DSH_SECRET_DEEPSEEK_API_KEY not set in this process");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function chat({ messages, maxTokens = 1024, thinking = "disabled" }) {
  const body = {
    model: MODEL,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
    thinking: { type: thinking },
  };
  const t0 = now();
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });
  const ms = now() - t0;
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: resp.status, ms, json, raw: text.slice(0, 1200) };
}

function usageOf(json) {
  const u = json?.usage || {};
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
  };
}

// ---------- T1 单段翻译 ----------
const t1 = await chat({
  messages: [
    { role: "system", content: "You are a translation engine. Translate the user's text into Simplified Chinese. Output the translation only." },
    { role: "user", content: "Kiss Translator is a minimalist bilingual translation extension." },
  ],
  maxTokens: 512,
});

// ---------- T2 批量 JSON 协议（8 段 + 行内占位符） ----------
const segments = [
  { id: 0, text: "This is the ⟦0⟧first⟦1⟧ paragraph with a ⟦2⟧link⟦3⟧ inside." },
  { id: 1, text: "The second paragraph is plain text without any inline markup." },
  { id: 2, text: "Third paragraph contains ⟦0⟧bold⟦1⟧ and ⟦2⟧code⟦3⟧ fragments." },
  { id: 3, text: "Fourth paragraph mentions DeepSeek and Chrome MV3 service workers." },
  { id: 4, text: "Fifth paragraph: the quick brown fox jumps over the lazy dog." },
  { id: 5, text: "Sixth paragraph should stay short and easy to verify." },
  { id: 6, text: "Seventh paragraph repeats the ⟦0⟧key phrase⟦1⟧ for testing." },
  { id: 7, text: "Eighth paragraph closes the batch with a simple sentence." },
];

const batchSystem = [
  "You are a batch translation engine. Input is a JSON array of {\"id\":number,\"text\":string}.",
  "Translate every text into Simplified Chinese. Keep the JSON ids and order exactly as given.",
  "Some texts contain placeholder tokens like ⟦0⟧ or ⟦1⟧. Copy them into the translation exactly, unchanged, in the same relative position.",
  "Output ONLY a valid JSON array of {\"id\":number,\"text\":string}. No markdown fences, no extra text.",
].join("\n");

const t2 = await chat({
  messages: [
    { role: "system", content: batchSystem },
    { role: "user", content: JSON.stringify(segments) },
  ],
  maxTokens: 2048,
});

function parseBatch(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end < start) return { ok: false, reason: "no-array", parsed: null };
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return { ok: true, parsed: arr };
  } catch (e) {
    return { ok: false, reason: "json-error:" + e.message, parsed: null };
  }
}

const pb = t2.json?.choices?.[0]?.message?.content
  ? parseBatch(t2.json.choices[0].message.content)
  : { ok: false, reason: "no-content", parsed: null };

function markersOf(text) {
  return [...String(text).matchAll(/⟦\d+⟧/g)].map((m) => m[0]).sort();
}

const fidelity = pb.parsed
  ? pb.parsed.map((item, index) => {
      const src = segments.find((s) => s.id === item?.id) || {};
      const expect = markersOf(src.text || "");
      const got = markersOf(item?.text || "");
      return {
        id: item?.id,
        orderOk: index === 0 || item?.id > pb.parsed[index - 1]?.id,
        markersExpected: expect,
        markersKept: JSON.stringify(expect) === JSON.stringify(got),
        translatedNonEmpty: typeof item?.text === "string" && item.text.trim().length > 0,
      };
    })
  : [];

const out = {
  model: MODEL,
  keyPresent: true,
  t1_single: {
    status: t1.status,
    latency_ms: t1.ms,
    content: t1.json?.choices?.[0]?.message?.content?.slice(0, 200) ?? null,
    reasoning_content_present: t1.json?.choices?.[0]?.message?.reasoning_content != null,
    usage: usageOf(t1.json),
    error: t1.status === 200 ? null : t1.raw,
  },
  t2_batch: {
    status: t2.status,
    latency_ms: t2.ms,
    parsed_ok: pb.ok,
    parse_error: pb.reason ?? null,
    ids: pb.parsed?.map((x) => x?.id) ?? null,
    id_count_ok: pb.parsed?.length === segments.length,
    all_markers_kept: fidelity.length === segments.length && fidelity.every((f) => f.markersKept),
    failures: fidelity.filter((f) => !f.markersKept || !f.translatedNonEmpty || !f.orderOk),
    usage: usageOf(t2.json),
    reasoning_content_present: t2.json?.choices?.[0]?.message?.reasoning_content != null,
    error: t2.status === 200 ? null : t2.raw,
  },
};

// 缓存命中再跑一次相同请求，观察 prompt_cache_hit_tokens
await sleep(500);
const t3 = await chat({
  messages: [
    { role: "system", content: "You are a translation engine. Translate the user's text into Simplified Chinese. Output the translation only." },
    { role: "user", content: "Kiss Translator is a minimalist bilingual translation extension." },
  ],
  maxTokens: 512,
});
out.t3_cache_repeat = { status: t3.status, latency_ms: t3.ms, usage: usageOf(t3.json) };

console.log(JSON.stringify(out, null, 2));
process.exit(out.t1_single.status === 200 && out.t2_batch.status === 200 ? 0 : 1);
