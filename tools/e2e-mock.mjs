/**
 * 端到端验证（无真实 Key）：本地 mock DeepSeek 接口 + Edge 加载扩展 + 断言富文本/块覆盖
 *
 * 用法：node tools/e2e-mock.mjs [--browser=msedge|chrome] [--keep]
 *
 * 说明：
 * - 用 CDP Fetch 域拦截扩展 service worker 发往 api.deepseek.com 的请求，返回构造好的译文
 * - mock 译文按行内标签拆分后给每个文本片段加 "【中文】" 前缀，故意保留占位符，用于验证链接/加粗等行内格式是否被正确还原
 * - 断言：块是否被翻译、行内标签是否保留、正文里是否出现残留占位符（{1} / <a1>）
 */

import { spawn, execSync } from "node:child_process";
import http from "node:http";
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
const PROFILE = path.join(os.tmpdir(), "dualread-e2e-" + Date.now());
const PAGE_PORT = 8093;
const CDP_PORT = 9346;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { browser: BROWSER, assertions: [], requestLog: [] };
const assert = (name, pass, detail = "") => {
  out.assertions.push({ name, pass, detail });
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`
  );
};

const html = `<!doctype html><html><head><meta charset="utf-8"><title>dualread e2e</title></head><body>
<h1>Rich text test page</h1>
<p id="p1">Read the <a href="https://example.com/doc">official <strong>documentation</strong></a> before you start.</p>
<p id="p2">Use <code>npm install</code> then <em>run</em> the build please.</p>
<div id="divblock">This sentence lives in a plain div without any paragraph tag at all.</div>
<ul><li id="li1">First bullet item with a <a href="/x">link</a> inside it.</li></ul>
</body></html>`;

const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, r));

// ---------- mock DeepSeek（通过 CDP Fetch 拦截，不需要真的监听端口） ----------
// 批量翻译的 JSON 数组固定在提示词末尾，但提示词正文本身可能含 [default] 这类方括号，
// 因此从右向左回退，取第一个能被完整解析的数组，避免 schema 变化后误切片。
function extractSegments(prompt) {
  const end = prompt.lastIndexOf("]");
  if (end < 0) return [];
  let start = prompt.lastIndexOf("[", end);
  while (start >= 0) {
    try {
      const parsed = JSON.parse(prompt.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    if (start === 0) break;
    start = prompt.lastIndexOf("[", start - 1);
  }
  return [];
}

// 译文标记：按内联标签切分后给每个文本片段加前缀，模拟“逐段翻译”的返回结果。
// 这样链接/加粗等行内节点内部也能体现译文，同时占位符标签保持原样供扩展还原。
function markTranslated(text) {
  return String(text)
    .split(/(<[^>]+>)/g)
    .map((part) =>
      part && !part.startsWith("<")
        ? part.replace(/\S/, (ch) => "【中文】" + ch)
        : part
    )
    .join("");
}

function mockCompletion(bodyText) {
  let items = [];
  try {
    const body = JSON.parse(bodyText);
    const userMsg = [...(body.messages || [])]
      .reverse()
      .find((m) => m.role === "user");
    items = extractSegments(userMsg?.content || "");
  } catch {}
  const translated = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id !== undefined && typeof it.text === "string")
    .map((it) => ({
      id: it.id,
      text: markTranslated(it.text),
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
const list = () =>
  fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());

let targets = [];
for (let i = 0; i < 60; i++) {
  await sleep(800);
  try {
    targets = await list();
    if (
      targets.some(
        (t) =>
          t.type === "service_worker" && /\/background\.js$/.test(t.url || "")
      )
    )
      break;
  } catch {}
}
const swTarget = targets.find(
  (t) => t.type === "service_worker" && /\/background\.js$/.test(t.url || "")
);
out.extensionLoaded = !!swTarget;
out.extensionId = swTarget?.url?.split("/")[2] ?? null;

let sw = null;
if (swTarget) {
  for (let attempt = 0; attempt < 5 && !sw; attempt++) {
    const c = await cdp(swTarget.webSocketDebuggerUrl);
    await c.send("Runtime.enable");
    const probe = await c.send("Runtime.evaluate", {
      expression: "typeof chrome !== 'undefined' && !!chrome.tabs",
      returnByValue: true,
    });
    if (probe.result?.value) sw = c;
    else c.close();
    if (!sw) await sleep(1200);
  }
}

const sessions = [];
if (sw) sessions.push({ name: "sw", c: sw });
for (const t of targets) {
  if (
    (t.url || "").startsWith("chrome-extension://") &&
    t.type !== "service_worker"
  ) {
    try {
      const c = await cdp(t.webSocketDebuggerUrl);
      await c.send("Runtime.enable");
      sessions.push({ name: t.type + ":" + (t.url.split("/")[2] || ""), c });
    } catch {}
  }
}
out.sessions = sessions.map((s) => s.name);

for (const s of sessions) {
  try {
    await s.c.send("Network.enable");
  } catch {}
  try {
    await s.c.send("Fetch.enable", {
      patterns: [
        { urlPattern: "https://api.deepseek.com/*", requestStage: "Request" },
      ],
    });
  } catch {}
}

out.allRequests = [];
out.consoleEvents = [];
out.fetchProbe = null;
setInterval(async () => {
  for (const s of sessions) {
    while (s.c.events.length) {
      const ev = s.c.events.shift();
      if (ev.method === "Fetch.requestPaused") {
        const { requestId, request } = ev.params;
        out.requestLog.push({
          session: s.name,
          url: request.url,
          body: (request.postData || "").slice(0, 800),
        });
        const body = mockCompletion(request.postData || "");
        await s.c
          .send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "content-type", value: "application/json" },
            ],
            body: Buffer.from(JSON.stringify(body)).toString("base64"),
          })
          .catch((e) =>
            out.requestLog.push({ session: s.name, fulfillError: String(e) })
          );
      } else if (ev.method === "Network.requestWillBeSent") {
        out.allRequests.push({
          session: s.name,
          url: ev.params.request.url.slice(0, 120),
          method: ev.params.request.method,
        });
      } else if (
        ev.method === "Runtime.consoleAPICalled" ||
        ev.method === "Runtime.exceptionThrown"
      ) {
        out.consoleEvents.push(
          ev.method === "Runtime.exceptionThrown"
            ? `${s.name} exception: ${String(ev.params.exceptionDetails?.exception?.description ?? "").slice(0, 240)}`
            : `${s.name} ${ev.params.type}: ` +
                ev.params.args
                  .map((a) => a.value ?? a.description ?? "")
                  .join(" ")
                  .slice(0, 200)
        );
      }
    }
  }
}, 80);

// 自检：确认 Fetch 拦截对 SW 发起的请求生效（在 pump 启动之后才发）
if (sw) {
  const probePromise = sw
    .send("Runtime.evaluate", {
      expression: `fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer mock" },
        body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "[{\\"id\\":0,\\"text\\":\\"probe\\"}]" }] })
      }).then(r => r.text()).then(t => t.slice(0, 120)).catch(e => "ERR:" + e.message)`,
      awaitPromise: true,
      returnByValue: true,
    })
    .then((r) => r.result?.value ?? r.exceptionDetails?.exception?.description)
    .catch((e) => "SEND-ERR:" + String(e));
  out.fetchProbe = await Promise.race([
    probePromise,
    sleep(4000).then(() => "TIMEOUT"),
  ]);
}

// 打补丁：种一个指向 mock 的 DeepSeek 服务实例（真实使用时由用户在 options 里配置）
if (sw) {
  const patch = await sw.send("Runtime.evaluate", {
    expression: `(async () => {
      const all = await chrome.storage.local.get(null);
      const key =
        Object.keys(all).find((k) => k.includes("_setting_v") && !k.includes("backup")) ||
        Object.keys(all).find((k) => /setting/i.test(k) && !/backup/i.test(k));
      let setting = {};
      if (key && typeof all[key] === "string") {
        try { setting = JSON.parse(all[key]) || {}; } catch (e) {}
      }
      const dsTemplate =
        (Array.isArray(setting.transApis) ? setting.transApis : []).find(
          (api) => api && (api.apiType === "DeepSeek" || api.apiSlug === "DeepSeek")
        ) || {};
      const ds = {
        ...dsTemplate,
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
      };
      setting.transApis = [ds];
      if (setting.version === undefined) setting.version = 5;
      const targetKey = key || 'KISS-Translator_setting_v2';
      await chrome.storage.local.set({ [targetKey]: JSON.stringify(setting) });
      const stored = (await chrome.storage.local.get([targetKey]))[targetKey];
      let parsed = null;
      try { parsed = JSON.parse(stored); } catch (e) {}
      return {
        ok: true, key: targetKey, hadExisting: !!key, version: setting.version,
        valueIsString: typeof stored === 'string',
        apiCount: parsed?.transApis?.length ?? -1,
        apiSlug: parsed?.transApis?.[0]?.apiSlug,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  out.storagePatch =
    patch.result?.value ??
    patch.exceptionDetails?.exception?.description ??
    null;
}

// 打开测试页
await fetch(
  `http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PAGE_PORT}/`,
  { method: "PUT" }
);
await sleep(3000);
const pageT = (await list()).find(
  (t) => t.type === "page" && t.url.includes("127.0.0.1")
);
out.pageLoaded = !!pageT;

let page = null;
if (pageT) {
  page = await cdp(pageT.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Log.enable");
}

if (!sw || !pageT) {
  // 扩展/页面未就绪时必须显式断言失败，避免“0 条断言”被误判为通过。
  // 新版 Chrome 品牌版已禁用 --load-extension，可改用 msedge 或把 DUALREAD_BROWSER_PATH 指向 Chrome for Testing。
  assert(
    "扩展与 mock 均就绪",
    false,
    !sw ? "扩展 Service Worker 未加载" : "测试页未打开"
  );
} else {
  const toggle = await sw.send("Runtime.evaluate", {
    expression: `chrome.tabs.query({}).then(async (ts) => {
      const t = ts.find(x => (x.url||'').includes('127.0.0.1'));
      if (!t) return 'no-tab';
      try { await chrome.tabs.sendMessage(t.id, { action: 'toggle_translate', args: null }); return 'sent'; }
      catch (e) { return 'err:' + e.message; }
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  out.toggle = toggle.result?.value;

  const evalPage = async (expression) => {
    const r = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return r.exceptionDetails
      ? { __error: r.exceptionDetails.exception?.description }
      : r.result.value;
  };
  // 翻译是异步的：轮询等待译文出现，避免慢机器上固定等待时间不足导致偶发失败
  let text = "";
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(1000);
    text = await evalPage("document.body.innerText");
    if (/【中文】/.test(String(text))) break;
  }
  const links = await evalPage(
    "JSON.stringify([...document.querySelectorAll('a[href]')].map(a => ({href:a.getAttribute('href'), text:a.innerText})))"
  );
  const strongs = await evalPage("document.querySelectorAll('strong').length");
  const ems = await evalPage("document.querySelectorAll('em').length");
  const remainPlaceholder = await evalPage(
    "/\\{\\d+\\}|<a\\d+>|<i\\d+>/.test(document.body.innerText)"
  );
  const blockTexts = await evalPage(
    "JSON.stringify([...document.querySelectorAll('h1,p,li,div')].map(e => e.innerText.slice(0,120)))"
  );
  out.toggle = out.toggle ?? null;
  out.pageConsole = page.events
    .filter(
      (e) =>
        e.method === "Runtime.consoleAPICalled" ||
        e.method === "Log.entryAdded" ||
        e.method === "Runtime.exceptionThrown"
    )
    .slice(-25)
    .map((e) => {
      if (e.method === "Log.entryAdded")
        return (
          "log:" +
          e.params.entry.level +
          ": " +
          String(e.params.entry.text).slice(0, 200)
        );
      if (e.method === "Runtime.exceptionThrown")
        return (
          "exception: " +
          String(
            e.params.exceptionDetails?.exception?.description ??
              e.params.exceptionDetails?.text
          ).slice(0, 300)
        );
      return (
        e.params.type +
        ": " +
        e.params.args
          .map((a) => a.value ?? a.description ?? "")
          .join(" ")
          .slice(0, 200)
      );
    });
  // 事件泵已经把 sw.events 消费进 allRequests / consoleEvents，这里直接复用，避免输出永远为空
  out.swNetwork = out.allRequests
    .filter((r) => r.session === "sw")
    .map((r) => r.method + " " + r.url);
  out.swConsole = out.consoleEvents
    .filter((line) => String(line).startsWith("sw "))
    .slice(-20);
  out.kissUi = await evalPage(
    "document.querySelectorAll('[data-kiss-ui]').length"
  );
  out.bodyHtml = await evalPage("document.body.innerHTML.slice(0, 600)");
  page.close();

  const parsedLinks = safeJson(links) || [];
  out.snapshot = {
    text: String(text).slice(0, 400),
    links: parsedLinks,
    strongs,
    ems,
    placeholderRemain: remainPlaceholder,
  };

  assert("扩展与 mock 均就绪", true);
  assert("页面出现中文译文", /【中文】/.test(String(text)));
  assert(
    "链接数量不变",
    parsedLinks.length >= 2,
    `links=${parsedLinks.length}`
  );
  assert(
    "链接内文本被翻译",
    parsedLinks.some((l) => /【中文】/.test(l.text))
  );
  assert("加粗标签保留", strongs >= 1, `strong=${strongs}`);
  assert("斜体标签保留", ems >= 1, `em=${ems}`);
  assert("正文无残留占位符", remainPlaceholder === false);
  assert(
    "div 纯文本块被翻译",
    /【中文】/.test(String(text)) && /plain div/i.test(String(text))
  );
}

console.log(JSON.stringify(out, null, 2));
try {
  pageServer.close();
} catch {}
if (!ARG.keep) {
  try {
    execSync(`taskkill /PID ${browser.pid} /T /F`, { stdio: "ignore" });
  } catch {}
}
const failed = out.assertions.filter((a) => !a.pass).length;
process.exit(failed === 0 ? 0 : 1);

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
