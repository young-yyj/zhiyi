/**
 * 站点规则与排除项实测（无真实 Key）：Edge 加载扩展 + CDP mock DeepSeek，
 * 跑 5 类公开站点，统计：
 *   - 视口内可译块覆盖率（排除 nav/footer/pre/code 等设计内忽略区）
 *   - 忽略区是否被误译（wrapper 出现在 nav/footer/pre/code/button 内）
 *   - 原文链接是否丢失（href 集合对比）、pre/code 文本是否被改动
 *   - 译文内占位符残留（{n} / <i1> / <a1>）
 *   - 页面异常、mock 请求数、耗时
 *
 * 用法：node tools/site-rules-check.mjs [--browser=msedge|chrome] [--keep] [--timeout=30000]
 * 产物：tmp/site-rules-report.md（tmp/ 已被 git 忽略）
 *
 * 说明：
 * - mock 译文 = "【中文】" + 原文，保留占位符，用于验证规则命中与行内格式还原；
 *   真实译文质量仍需真实 Key 手动验收（S0/人工复核）。
 * - 与 e2e-mock.mjs 同一套机制：CDP Fetch 拦截扩展 SW 发往 api.deepseek.com 的请求。
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ARG = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("="))
);
// 项目根由脚本位置反推，仓库可整体移动到任意目录
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROWSER = ARG.browser || "msedge";
const BROWSER_CANDIDATES = {
  chrome: [
    process.env.DUALREAD_BROWSER_PATH,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ],
  msedge: [
    process.env.DUALREAD_BROWSER_PATH,
    process.env.EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ],
};
const CHROME = (BROWSER_CANDIDATES[BROWSER] || []).find(
  (item) => item && fs.existsSync(item)
);
if (!CHROME) {
  console.error(
    "找不到浏览器：" +
      BROWSER +
      "。用 --browser=chrome|msedge 选择，或设置 DUALREAD_BROWSER_PATH。"
  );
  process.exit(1);
}
const EXT = path.join(ROOT, "build", "chrome");
const REPORT = path.join(ROOT, "tmp", "site-rules-report.md");
const PROFILE = path.join(os.tmpdir(), "dualread-site-check-" + Date.now());
const CDP_PORT = 9347;
const LOAD_TIMEOUT = Number(ARG.timeout || 30000);
const TRANSLATE_TIMEOUT = 25000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITES = [
  { key: "news", label: "新闻", url: "https://text.npr.org/" },
  {
    key: "docs",
    label: "文档",
    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  },
  {
    key: "github",
    label: "GitHub README",
    url: "https://github.com/microsoft/vscode",
  },
  { key: "forum", label: "论坛", url: "https://news.ycombinator.com/" },
  { key: "spa", label: "React SPA/文档", url: "https://react.dev/learn" },
];

const ONLY = (ARG.only || "").split(",").filter(Boolean);
const ACTIVE_SITES = ONLY.length
  ? SITES.filter((site) => ONLY.includes(site.key))
  : SITES;

const out = {
  startedAt: new Date().toISOString(),
  browser: BROWSER,
  extensionId: null,
  mockRequests: 0,
  sites: [],
  notes: [],
  swConsole: [],
  swRequests: [],
};

// ---------- mock DeepSeek ----------
function mockCompletion(bodyText) {
  let items = [];
  try {
    const body = JSON.parse(bodyText);
    const userMsg = [...(body.messages || [])]
      .reverse()
      .find((m) => m.role === "user");
    const rawPrompt = userMsg?.content || "";
    // 提示词里会先出现 "[default]" 这类风格标记，段落实体是最后一个 JSON 数组
    const start = rawPrompt.lastIndexOf("[{");
    const end = rawPrompt.lastIndexOf("]");
    if (start >= 0 && end > start) {
      items = JSON.parse(rawPrompt.slice(start, end + 1));
    }
  } catch {}
  const translated = (Array.isArray(items) ? items : []).map((it) => ({
    id: it.id,
    text: "【中文】" + it.text,
  }));
  return {
    id: "mock-" + Date.now(),
    object: "chat.completion",
    model: "deepseek-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify(translated),
          reasoning_content: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

// ---------- 启动浏览器 ----------
const browser = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--user-data-dir=" + PROFILE,
    "--load-extension=" + EXT,
    "--remote-debugging-port=" + CDP_PORT,
    "about:blank",
  ],
  { stdio: "ignore" }
);

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) events.push(msg);
    };
    ws.onopen = () => resolve({ send, events, close: () => ws.close() });
    ws.onerror = () => reject(new Error("ws error"));
  });
}

const listTargets = () =>
  fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());

// ---------- 等 SW 就绪 ----------
let targets = [];
for (let i = 0; i < 80; i++) {
  await sleep(500);
  try {
    targets = await listTargets();
    if (
      targets.some(
        (t) =>
          t.type === "service_worker" && /\/background\.js$/.test(t.url || "")
      )
    ) {
      break;
    }
  } catch {}
}
const swTarget = targets.find(
  (t) => t.type === "service_worker" && /\/background\.js$/.test(t.url || "")
);
out.extensionId = swTarget?.url?.split("/")[2] ?? null;
if (!swTarget) {
  out.notes.push("扩展 SW 未就绪，脚本退出");
  console.error(JSON.stringify(out, null, 2));
  try {
    execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: "ignore" });
  } catch {}
  process.exit(1);
}

const sw = await cdp(swTarget.webSocketDebuggerUrl);
await sw.send("Runtime.enable");
await sw.send("Network.enable");

// 拦截扩展所有 target（SW / offscreen 等）的 DeepSeek 请求
const sessions = [{ name: "sw", c: sw }];
for (const t of targets) {
  if (
    (t.url || "").startsWith("chrome-extension://") &&
    t.type !== "service_worker"
  ) {
    try {
      const c = await cdp(t.webSocketDebuggerUrl);
      await c.send("Runtime.enable");
      sessions.push({ name: t.type, c });
    } catch {}
  }
}
for (const s of sessions) {
  try {
    await s.c.send("Fetch.enable", {
      patterns: [
        { urlPattern: "https://api.deepseek.com/*", requestStage: "Request" },
      ],
    });
  } catch {}
}

// 扩展可能在翻译期间新开 target（如 offscreen document），需要动态挂载后再拦截
let lastRescan = 0;
async function attachExtensionTargets() {
  lastRescan = Date.now();
  let listNow = [];
  try {
    listNow = await listTargets();
  } catch {
    return;
  }
  for (const t of listNow) {
    if (!(t.url || "").startsWith("chrome-extension://")) continue;
    if (t.type === "service_worker") continue;
    if (sessions.some((s) => s.targetId === t.id)) continue;
    try {
      const c = await cdp(t.webSocketDebuggerUrl);
      await c.send("Runtime.enable");
      await c.send("Network.enable");
      await c.send("Fetch.enable", {
        patterns: [
          { urlPattern: "https://api.deepseek.com/*", requestStage: "Request" },
        ],
      });
      sessions.push({ name: t.type, c, targetId: t.id });
      out.notes.push("late-attached target: " + t.type + " " + (t.url || ""));
    } catch {}
  }
}
setInterval(async () => {
  if (Date.now() - lastRescan > 2000) attachExtensionTargets();
  for (const s of sessions) {
    while (s.c.events.length) {
      const ev = s.c.events.shift();
      if (ev.method === "Fetch.requestPaused") {
        out.mockRequests += 1;
        out.swRequests.push("fetch " + ev.params.request.url);
        const body = mockCompletion(ev.params.request.postData || "");
        await s.c
          .send("Fetch.fulfillRequest", {
            requestId: ev.params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "content-type", value: "application/json" },
            ],
            body: Buffer.from(JSON.stringify(body)).toString("base64"),
          })
          .catch(() => {});
      } else if (ev.method === "Network.requestWillBeSent") {
        out.swRequests.push(
          ev.params.request.method + " " + ev.params.request.url.slice(0, 140)
        );
        if (out.swRequests.length > 60) out.swRequests.shift();
      } else if (
        ev.method === "Runtime.consoleAPICalled" ||
        ev.method === "Runtime.exceptionThrown"
      ) {
        const text =
          ev.method === "Runtime.exceptionThrown"
            ? "exception: " +
              String(
                ev.params.exceptionDetails?.exception?.description || ""
              ).slice(0, 240)
            : ev.params.type +
              ": " +
              ev.params.args
                .map((a) => a.value ?? a.description ?? "")
                .join(" ")
                .slice(0, 240);
        out.swConsole.push(s.name + " " + text);
        if (out.swConsole.length > 40) out.swConsole.shift();
      }
    }
  }
}, 60);

// ---------- 种 mock DeepSeek 服务实例 ----------
const firstPass = await sw.send("Runtime.evaluate", {
  expression: `chrome.storage.local.get(null).then((all) => Object.keys(all))`,
  awaitPromise: true,
  returnByValue: true,
});
out.storageKeys =
  firstPass.result?.value ??
  firstPass.exceptionDetails?.exception?.description ??
  null;
out.storageKeysRaw = JSON.stringify(firstPass).slice(0, 500);
const settingKey =
  Array.isArray(out.storageKeys) &&
  out.storageKeys.find((k) => /setting/i.test(k));

if (settingKey) {
  const dsLiteral = `{
    apiSlug: 'DeepSeek', apiName: 'DeepSeek', apiType: 'DeepSeek', sourceType: 'network',
    url: 'https://api.deepseek.com/chat/completions',
    modelListUrl: 'https://api.deepseek.com/models',
    key: 'mock-key', model: 'deepseek-flash',
    systemPrompt: '', userPrompt: '', tone: 'default',
    batchPromptSlug: 'batch-translation-json',
    subtitlePromptSlug: 'subtitle-segmentation',
    dictPromptSlug: 'dictionary-en-zh',
    nobatchPromptSlug: 'nobatch-translation-concise',
    vlmPromptSlug: 'vlm-document',
    placeholder: '{ }', placetag: 'i', placetagFormat: 'compact',
    temperature: 0, maxTokens: 8192,
    useBatchFetch: true, batchSize: 8, batchLength: 4000, batchConcurrency: 3,
    batchInterval: 400, fetchLimit: 10, fetchInterval: 100, httpTimeout: 120,
    thinkingMode: 'disabled', thinkingEffort: '_default',
    useStream: false, streamRenderMode: 'disabled',
    isDisabled: false, sortOrder: 0, rootMargin: 500,
    useContext: false, contextSize: 3, transAllnow: false,
  }`;
  const patch = await sw.send("Runtime.evaluate", {
    expression: `(async () => {
      const all = await chrome.storage.local.get(null);
      const raw = all[${JSON.stringify(settingKey)}];
      let s = {};
      if (typeof raw === "string") {
        try { s = JSON.parse(raw) || {}; } catch (e) { s = {}; }
      } else if (raw && typeof raw === "object") {
        s = raw;
      }
      s.transApis = [${dsLiteral}];
      const stored = typeof raw === "string" ? JSON.stringify(s) : s;
      await chrome.storage.local.set({ [${JSON.stringify(settingKey)}]: stored });
      return { ok: true, key: ${JSON.stringify(settingKey)}, apiCount: s.transApis.length, storedType: typeof stored };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  out.storagePatch =
    patch.result?.value ?? patch.exceptionDetails?.exception?.description;
  out.patchRaw = JSON.stringify(patch).slice(0, 600);
} else {
  out.notes.push("setting key not found: " + JSON.stringify(out.storageKeys));
}

// ---------- 单站采集 ----------
const METRICS = `(() => {
  const wrapperSel = ".kiss-translator-wrapper";
  const innerSel = ".kiss-translator-inner";
  const matchedSel = "h1,h2,h3,h4,h5,h6,li,p,dd,blockquote,figcaption,label,legend";
  const ignoredSel = "nav, footer, pre, code, button, [translate='no'], .notranslate";
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > -400 && r.top < innerHeight + 400;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    // 折叠/隐藏容器里的元素没有布局盒，getClientRects 为空
    return el.getClientRects().length > 0;
  };
  const directText = (el) => {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) text += node.textContent;
    }
    return text.trim();
  };
  const seen = new Set();
  const candidates = [];
  // 规则选择器命中的正文块
  for (const el of document.querySelectorAll(matchedSel)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!visible(el) || !inView(el) || el.closest(ignoredSel)) continue;
    if (!/[A-Za-z]{2,}/.test(el.innerText) || el.innerText.trim().length < 30) continue;
    candidates.push({ el, kind: "selector" });
  }
  // 自动扫描（bare text）可能命中的宿主：凡是「直接文本」够长的元素都可能被扫到
  for (const el of document.querySelectorAll("body *")) {
    if (seen.has(el)) continue;
    seen.add(el);
    const direct = directText(el);
    if (!/[A-Za-z]{2,}/.test(direct) || direct.length < 30) continue;
    if (!visible(el) || !inView(el) || el.closest(ignoredSel)) continue;
    candidates.push({ el, kind: "barescan" });
  }
  // 自动扫描的译文容器可能挂在候选元素的父级（如 <a> 的宿主 span），向上看 3 层
  const covered = candidates.filter(({ el }) => {
    let node = el;
    for (let depth = 0; depth < 3 && node; depth++, node = node.parentElement) {
      if (node.querySelector(wrapperSel)) return true;
    }
    return false;
  });
  const wrappers = [...document.querySelectorAll(wrapperSel)];
  const residue = wrappers.filter((w) => /<i\\d+>|<a\\d+>|\\{\\d+\\}/.test(w.innerText)).length;
  const ignoredWrapperSel = "nav .kiss-translator-wrapper, footer .kiss-translator-wrapper, pre .kiss-translator-wrapper, code .kiss-translator-wrapper, button .kiss-translator-wrapper, [translate='no'] .kiss-translator-wrapper, .notranslate .kiss-translator-wrapper";
  const inIgnored = [...document.querySelectorAll(ignoredWrapperSel)].length;
  const inIgnoredKind = {};
  for (const [kind, sel] of [["nav","nav"],["footer","footer"],["pre","pre"],["code","code"],["button","button"]]) {
    const n = document.querySelectorAll(sel + " " + wrapperSel).length;
    if (n) inIgnoredKind[kind] = n;
  }
  const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
  const pre = [...document.querySelectorAll("pre")].map((el) => el.innerText);
  const codes = [...document.querySelectorAll("code")].map((el) => el.innerText);
  const translated = document.body.innerText.includes("【中文】");
  return {
    url: location.href,
    textLen: document.body.innerText.length,
    translated,
    wrapperCount: wrappers.length,
    blocks: candidates.length,
    covered: covered.length,
    coverage: candidates.length ? covered.length / candidates.length : null,
    matchedCandidates: candidates.filter((c) => c.kind === "selector").length,
    bareCandidates: candidates.filter((c) => c.kind === "barescan").length,
    residue,
    inIgnored,
    inIgnoredKind,
    hrefs,
    pre,
    codes,
    untranslatedSamples: candidates
      .filter(({ el }) => {
        let node = el;
        for (let depth = 0; depth < 3 && node; depth++, node = node.parentElement) {
          if (node.querySelector(wrapperSel)) return false;
        }
        return true;
      })
      .slice(0, 3)
      .map(({ el }) => el.innerText.replace(/\\s+/g, " ").slice(0, 80)),
    firstTranslated: (document.querySelector(wrapperSel + " " + innerSel)?.innerText || "").slice(0, 60),
    wrapperSample: (document.querySelector(wrapperSel)?.innerHTML || "").slice(0, 240),
    wrapperHosts: wrappers.slice(0, 12).map((w) => {
      const p = w.parentElement;
      return p ? p.tagName.toLowerCase() + (p.className ? "." + String(p.className).split(" ")[0] : "") : "detached";
    }),
    candidateProbe: candidates.slice(0, 6).map(({ el }) => {
      let hit = "none";
      let p = el;
      for (let depth = 0; depth < 4 && p; depth++, p = p.parentElement) {
        if (p.querySelector(wrapperSel)) {
          hit = depth + ":" + p.tagName.toLowerCase();
          break;
        }
      }
      return el.tagName.toLowerCase() + "=>" + hit;
    }),
  };
})()`;

const pageErrors = [];
let currentPage = null;

async function evaluatePage(expression) {
  const r = await currentPage.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        "page evaluate error"
    );
  }
  return r.result.value;
}

async function waitForPageReady() {
  const started = Date.now();
  while (Date.now() - started < LOAD_TIMEOUT) {
    try {
      const state = await evaluatePage(
        `JSON.stringify({ ready: document.readyState, len: document.body ? document.body.innerText.length : 0 })`
      );
      const { ready, len } = JSON.parse(state || "{}");
      if (ready === "complete" && len > 300) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function sendToggle(origin) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await sw.send("Runtime.evaluate", {
        expression: `chrome.tabs.query({}).then(async (ts) => {
          const t = ts.find((x) => (x.url || "").startsWith(${JSON.stringify(origin)}));
          if (!t) return "no-tab";
          try {
            await chrome.tabs.sendMessage(t.id, { action: "toggle_translate", args: null });
            return "sent";
          } catch (e) {
            return "err:" + (e && e.message);
          }
        })`,
        awaitPromise: true,
        returnByValue: true,
      });
      const value = r.result?.value ?? "eval-error";
      if (value === "sent") return value;
    } catch (e) {
      out.notes.push("toggle error: " + String(e).slice(0, 120));
    }
    await sleep(800);
  }
  return "toggle-failed";
}

async function waitForTranslation() {
  const started = Date.now();
  let best = 0;
  let stable = 0;
  while (Date.now() - started < TRANSLATE_TIMEOUT) {
    try {
      const n = await evaluatePage(
        `document.querySelectorAll(".kiss-translator-wrapper").length`
      );
      if (n > 0 && n === best) stable += 1;
      else stable = 0;
      best = Math.max(best, n);
      if (n > 0 && stable >= 3) return n;
    } catch {}
    await sleep(600);
  }
  return best;
}

const browserClosed = () => {
  try {
    return browser.exitCode !== null;
  } catch {
    return false;
  }
};

for (const site of ACTIVE_SITES) {
  const started = Date.now();
  const record = {
    key: site.key,
    label: site.label,
    url: site.url,
    ok: false,
    mockRequestsDelta: 0,
    pageExceptions: 0,
    errors: [],
  };
  const beforeMock = out.mockRequests;
  let pageTargetId = null;
  try {
    if (browserClosed()) throw new Error("browser exited");
    const origin = new URL(site.url).origin;
    const created = await fetch(
      `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(site.url)}`,
      { method: "PUT" }
    ).then((r) => r.json());
    pageTargetId = created.id;
    currentPage = await cdp(created.webSocketDebuggerUrl);
    await currentPage.send("Runtime.enable");
    await currentPage.send("Page.enable");
    await currentPage.send("Network.enable");
    await currentPage.send("Log.enable");

    const ready = await waitForPageReady();
    record.pageLoaded = ready;
    if (!ready) record.errors.push("page not ready in time");

    const before = await evaluatePage(METRICS);
    const toggleResult = await sendToggle(origin);
    record.toggle = toggleResult;
    const wrapperCount = await waitForTranslation();
    await sleep(2500);
    const after = await evaluatePage(METRICS);

    record.ok = true;
    record.mockRequestsDelta = out.mockRequests - beforeMock;
    record.pageExceptions = currentPage.events.filter(
      (e) => e.method === "Runtime.exceptionThrown"
    ).length;
    record.before = {
      hrefs: before.hrefs,
      pre: before.pre,
      codes: before.codes,
      textLen: before.textLen,
    };
    record.after = {
      translated: after.translated,
      wrapperCount: after.wrapperCount,
      blocks: after.blocks,
      matchedCandidates: after.matchedCandidates,
      bareCandidates: after.bareCandidates,
      covered: after.covered,
      coverage: after.coverage,
      residue: after.residue,
      inIgnored: after.inIgnored,
      inIgnoredKind: after.inIgnoredKind,
      hrefs: after.hrefs,
      pre: after.pre,
      codes: after.codes,
      textLen: after.textLen,
      untranslatedSamples: after.untranslatedSamples,
      firstTranslated: after.firstTranslated,
      wrapperSample: after.wrapperSample,
      wrapperHosts: after.wrapperHosts,
      candidateProbe: after.candidateProbe,
    };
    record.missingHrefSamples = countMissing(before.hrefs, after.hrefs);
    record.missingHrefs = record.missingHrefSamples.length;
    record.linkCountDelta = after.hrefs.length - before.hrefs.length;
    record.preLost = countMissing(before.pre, after.pre).length;
    record.codeLost = countMissing(before.codes, after.codes).length;
    record.wrapperCount = wrapperCount;
    record.pageRequests = currentPage.events
      .filter((e) => e.method === "Network.requestWillBeSent")
      .map(
        (e) =>
          e.params.request.method + " " + e.params.request.url.slice(0, 160)
      )
      .slice(-40);
    record.pageConsole = currentPage.events
      .filter(
        (e) =>
          e.method === "Runtime.consoleAPICalled" ||
          e.method === "Log.entryAdded" ||
          e.method === "Runtime.exceptionThrown"
      )
      .slice(-20)
      .map((e) => {
        if (e.method === "Log.entryAdded") {
          return (
            "log:" +
            e.params.entry.level +
            ": " +
            String(e.params.entry.text).slice(0, 200)
          );
        }
        if (e.method === "Runtime.exceptionThrown") {
          return (
            "exception: " +
            String(
              e.params.exceptionDetails?.exception?.description ||
                e.params.exceptionDetails?.text ||
                ""
            ).slice(0, 240)
          );
        }
        return (
          e.params.type +
          ": " +
          e.params.args
            .map((a) => a.value ?? a.description ?? "")
            .join(" ")
            .slice(0, 200)
        );
      });
  } catch (e) {
    record.errors.push(String(e).slice(0, 300));
  } finally {
    record.durationMs = Date.now() - started;
    try {
      if (pageTargetId) {
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${pageTargetId}`);
      }
    } catch {}
    try {
      currentPage?.close();
    } catch {}
    currentPage = null;
    out.sites.push(record);
    console.log(
      `[${site.key}] ok=${record.ok} wrapper=${record.wrapperCount ?? "-"} coverage=${
        record.after ? (record.after.coverage * 100).toFixed(1) + "%" : "-"
      } requests=${record.mockRequestsDelta} ${record.errors[0] || ""}`
    );
  }
}

function countMissing(beforeList, afterList) {
  const afterCount = new Map();
  for (const item of afterList || []) {
    afterCount.set(item, (afterCount.get(item) || 0) + 1);
  }
  const missing = [];
  for (const item of beforeList || []) {
    const n = afterCount.get(item) || 0;
    if (n > 0) afterCount.set(item, n - 1);
    else missing.push(item);
  }
  return missing;
}

function countChanged(beforeList, afterList) {
  const a = beforeList || [];
  const b = afterList || [];
  if (a.length !== b.length) return Math.abs(a.length - b.length) + 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) changed += 1;
  }
  return changed;
}

// ---------- 生成报告 ----------
function fmtPct(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "-";
}

const okSites = out.sites.filter((s) => s.ok);
const failedSites = out.sites.filter((s) => !s.ok);
const coverageSites = okSites.filter((s) => Number.isFinite(s.after?.coverage));
const avgCoverage = coverageSites.length
  ? coverageSites.reduce((sum, s) => sum + s.after.coverage, 0) /
    coverageSites.length
  : null;
const totalMissingHrefs = okSites.reduce(
  (sum, s) => sum + (s.missingHrefs || 0),
  0
);
const totalLinkDelta = okSites.reduce(
  (sum, s) => sum + (s.linkCountDelta || 0),
  0
);
const totalResidue = okSites.reduce(
  (sum, s) => sum + (s.after?.residue || 0),
  0
);
const totalIgnoredHits = okSites.reduce(
  (sum, s) => sum + (s.after?.inIgnored || 0),
  0
);
const totalPreLost = okSites.reduce((sum, s) => sum + (s.preLost || 0), 0);
const totalCodeLost = okSites.reduce((sum, s) => sum + (s.codeLost || 0), 0);

const lines = [];
lines.push("# 站点规则与排除项实测报告");
lines.push("");
lines.push(`> 生成时间：${out.startedAt}`);
lines.push(
  `> 运行方式：Edge（headless）+ 扩展 \`build/chrome\` + CDP mock DeepSeek（译文为「【中文】+ 原文」，**不是真实译文**）`
);
lines.push(
  `> 扩展 ID：\`${out.extensionId || "unknown"}\`；mock 请求总数：${out.mockRequests}`
);
lines.push("");
lines.push("## 结论");
lines.push("");
lines.push(
  `- 5 类站点中 ${okSites.length}/${SITES.length} 个完成采集；平均视口可译块覆盖率 **${fmtPct(avgCoverage)}**。`
);
lines.push(
  `- 忽略区误译（nav/footer/pre/code/button 内出现译文容器）：**${totalIgnoredHits}** 处；pre/code 文本丢失：pre ${totalPreLost} 处、code ${totalCodeLost} 处。`
);
lines.push(
  `- 原文链接数变化：**${totalLinkDelta >= 0 ? "+" : ""}${totalLinkDelta}**（href 多重集合消失 ${totalMissingHrefs} 个，含动态签名 URL 刷新，需人工甄别）；译文容器内占位符残留：**${totalResidue}** 处。`
);
lines.push("");
lines.push("## 规则观察");
lines.push("");
const bareOnlySites = okSites
  .filter(
    (s) =>
      (s.after?.matchedCandidates || 0) === 0 &&
      (s.after?.bareCandidates || 0) > 0
  )
  .map((s) => s.label);
lines.push(
  `- 规则选择器 vs 自动扫描：${
    bareOnlySites.length
      ? bareOnlySites.join("、") + " 完全没有命中规则标签，全靠自动扫描"
      : "各站均有规则标签命中"
  }；自动扫描两类站点都会把译文挂在父级宿主（如 HN 的 \`<a>\` → \`span.titleline\`），覆盖率判定已按向上 3 层宿主计入。`
);
const githubSite = okSites.find((s) => s.key === "github");
if (githubSite) {
  lines.push(
    `- 短文本宿主不在分母内：GitHub 本页译文容器 ${githubSite.after?.wrapperCount ?? "-"} 个、≥30 字符长文本候选仅 ${
      githubSite.after?.blocks ?? "-"
    } 个，说明多数命中是导航/按钮/短标签；覆盖率只对长文本块负责。`
  );
}
lines.push(
  `- 排除项：忽略区（nav/footer/pre/code/button）内译文容器 **${totalIgnoredHits}** 个，pre/code 文本丢失 **${
    totalPreLost + totalCodeLost
  }** 处（0 即排除项生效）。`
);
lines.push(
  `- 行内格式：译文容器内占位符残留 **${totalResidue}** 处（0 即行内标签还原正常）。`
);
const linkUp = okSites
  .filter((s) => s.linkCountDelta > 0)
  .map((s) => `${s.label} +${s.linkCountDelta}`);
const linkDown = okSites
  .filter((s) => s.linkCountDelta < 0)
  .map((s) => `${s.label} ${s.linkCountDelta}`);
lines.push(
  `- 链接数量变化：${
    linkUp.length
      ? linkUp.join("、") + "（译文镜像行内标签，属预期）"
      : "无增加"
  }；${
    linkDown.length
      ? linkDown.join("、") + "（页面运行时重写/水合链接，需人工确认）"
      : "无减少"
  }。`
);
lines.push("");
lines.push("## 站点明细");
lines.push("");
lines.push(
  "| 类型 | 站点 | 页面就绪 | 视口可译块 | 已译块 | 覆盖率 | 忽略区误译 | 链接Δ/消失 | pre/code 丢失 | 占位符残留 | mock 请求 | 页面异常 | 耗时 |"
);
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const s of out.sites) {
  lines.push(
    `| ${s.label} | ${s.url} | ${s.pageLoaded ? "✅" : "❌"} | ${
      s.after?.blocks ?? "-"
    } | ${s.after?.covered ?? "-"} | ${fmtPct(s.after?.coverage)} | ${
      s.after?.inIgnored ?? "-"
    } | ${(s.linkCountDelta >= 0 ? "+" : "") + (s.linkCountDelta ?? "-")}/${
      s.missingHrefs ?? "-"
    } | ${(s.preLost ?? 0) + (s.codeLost ?? 0)} | ${
      s.after?.residue ?? "-"
    } | ${s.mockRequestsDelta} | ${s.pageExceptions ?? "-"} | ${s.durationMs}ms |`
  );
}
lines.push("");
if (failedSites.length) {
  lines.push("## 采集失败/异常");
  lines.push("");
  for (const s of failedSites) {
    lines.push(`- ${s.label} \`${s.url}\`：${s.errors[0] || "unknown"}`);
  }
  lines.push("");
}
lines.push("## 复现方式");
lines.push("");
lines.push("```bash");
lines.push(
  "cd app && node tools/site-rules-check.mjs                     # 全部 5 类站点"
);
lines.push(
  "cd app && node tools/site-rules-check.mjs --only=news,github  # 只跑指定站点"
);
lines.push("```");
lines.push("");
lines.push(
  "前提：已执行 `pnpm build:chrome`（脚本加载 `app/build/chrome`）；无需真实 Key（CDP 拦截 `api.deepseek.com` 并返回 mock 译文）。"
);
lines.push("");
lines.push("## 说明与限制");
lines.push("");
lines.push(
  "- 覆盖率分母为「视口内、可见、含 ≥30 字符英文文本、且不在设计内忽略区」的候选宿主：规则选择器命中的块级元素 + 自动扫描（bare text）可能命中的任意元素（按直接文本判断）。已译判定允许译文容器落在候选元素本身或其向上 3 层宿主内（自动扫描常把译文挂在父级，如 HN 的 `<a>` → `span.titleline`）。分母不区分被内置规则（URL/数字/代码等）主动跳过的块，因此覆盖率 <100% 不一定是缺陷。"
);
lines.push(
  "- 「链接Δ/消失」：Δ 为翻译前后前端可见 `a[href]` 数量变化；消失数为 href 多重集合差异，GitHub 签名图片 URL、React 文档的 codesandbox 链接等会在页面运行时刷新/重写，消失不一定代表翻译删链接，需人工甄别。"
);
lines.push(
  "- mock 译文只验证「规则命中 / 排除项 / 行内占位符还原 / 链接保留」，**不能**代表真实译文质量与语序；真实质量需真实 Key 人工验收（见 `docs/acceptance-checklist.md` F-1/F-3 与 S0）。"
);
lines.push(
  "- 忽略区误译按 `nav/footer/pre/code/button` 统计；`code` 属于 keepSelector（保留原样），出现译文容器即为异常。"
);
lines.push("");
lines.push("## 未译块样例（前 3 条/站点）");
lines.push("");
for (const s of out.sites) {
  const samples = s.after?.untranslatedSamples || [];
  if (!samples.length) continue;
  lines.push(`### ${s.label}`);
  for (const sample of samples)
    lines.push(`- \`${sample.replace(/\|/g, "\\|")}\``);
  lines.push("");
}
lines.push(
  "> 未译块多为纯 URL/用户名/数字等被内置规则主动跳过的内容（如论坛的 `github.com/krushnavardhanreddy`），需人工判断是否缺陷。"
);
lines.push("");
lines.push("## 原始数据（JSON）");
lines.push("");
lines.push("```json");
const compactSites = out.sites.map((s) => {
  const a = s.after || {};
  return {
    key: s.key,
    label: s.label,
    url: s.url,
    ok: s.ok,
    pageLoaded: s.pageLoaded,
    toggle: s.toggle,
    mockRequestsDelta: s.mockRequestsDelta,
    pageExceptions: s.pageExceptions,
    durationMs: s.durationMs,
    blocks: a.blocks,
    matchedCandidates: a.matchedCandidates,
    bareCandidates: a.bareCandidates,
    covered: a.covered,
    coverage: a.coverage,
    wrapperCount: a.wrapperCount,
    residue: a.residue,
    inIgnored: a.inIgnored,
    inIgnoredKind: a.inIgnoredKind,
    missingHrefs: s.missingHrefs,
    missingHrefSamples: (s.missingHrefSamples || []).slice(0, 3),
    linkCountDelta: s.linkCountDelta,
    preLost: s.preLost,
    codeLost: s.codeLost,
    untranslatedSamples: a.untranslatedSamples,
    firstTranslated: a.firstTranslated,
    wrapperHosts: (a.wrapperHosts || []).slice(0, 6),
    errors: s.errors,
  };
});
lines.push(
  JSON.stringify(
    {
      summary: {
        avgCoverage,
        totalLinkDelta,
        totalMissingHrefs,
        totalResidue,
        totalIgnoredHits,
        totalPreLost,
        totalCodeLost,
      },
      storagePatch: out.storagePatch,
      swConsole: out.swConsole,
      notes: out.notes,
      sites: compactSites,
    },
    null,
    2
  )
);
lines.push("```");

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, lines.join("\n") + "\n", "utf8");
console.log(
  JSON.stringify(
    {
      report: REPORT,
      summary: {
        okSites: okSites.length,
        avgCoverage,
        totalMissingHrefs,
        totalResidue,
        totalIgnoredHits,
      },
    },
    null,
    2
  )
);

try {
  browser.kill("SIGKILL");
} catch {}
if (!ARG.keep) {
  try {
    execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: "ignore" });
  } catch {}
}
process.exit(okSites.length ? 0 : 1);
