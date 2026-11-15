// Run with `node test/staff-navigation.browser.mjs`. This builds and serves an
// isolated site with a synthetic staff endpoint and exercises it in Chrome.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const candidates = process.env.EXAMERFRAME_CHROME_PATH ? [process.env.EXAMERFRAME_CHROME_PATH] : [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
];
const chromePath = (await Promise.all(candidates.map((path) => access(path).then(() => path, () => null)))).find(Boolean);
assert.ok(chromePath, "Set EXAMERFRAME_CHROME_PATH to a Chrome executable");

const bank = Array.from({ length: 29 }, (_, index) => ({
  external_id: `Q-${String(index + 1).padStart(3, "0")}`,
  question_version_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  version_no: 1,
  stem: index === 28 ? "定位用的算术题：二加三等于多少？" : `合成算术题 ${index + 1}`,
  options: [{ id: "A", text: "五" }, { id: "B", text: index < 13 || index === 28 ? "选项命中 %_" : "十" }],
  standard_answer: "A", explanation: "合成解析", quality: null,
}));
const requests = [];
const tempRoot = join(process.cwd(), "supabase", ".temp");
await mkdir(tempRoot, { recursive: true });
const directory = await mkdtemp(join(tempRoot, "staff-navigation-"));
const outDir = join(directory, "dist");
const profile = join(directory, "chrome");

function api(request, body) {
  requests.push(body);
  if (body.action === "login") {
    assert.equal(body.key, "synthetic-browser-key");
    return { token: "synthetic-browser-token", expires_at: Date.now() / 1000 + 120 };
  }
  assert.equal(request.headers.authorization, "Bearer synthetic-browser-token");
  if (body.action === "rate") {
    const question = bank.find((item) => item.question_version_id === body.question_version_id);
    assert.ok(question);
    question.quality = body.quality;
    return { quality: body.quality };
  }
  assert.equal(body.action, "browse");
  const match = (value) => value.includes(body.query);
  const filtered = body.query ? bank.filter((question) => match(question.external_id) || match(question.stem) ||
    question.options.some((option) => match(option.text))) : bank;
  const total_pages = Math.ceil(filtered.length / 12);
  const index = bank.findIndex((question) => question.external_id === body.external_id);
  if (body.external_id) assert.notEqual(index, -1);
  const page = body.external_id ? Math.floor(index / 12) + 1 : Math.min(body.page, total_pages || 1);
  const rows = filtered.slice((page - 1) * 12, page * 12);
  return { page, total_pages, total_count: filtered.length, questions: body.query ? [] : rows,
    matches: body.query ? rows.map((question) => ({ external_id: question.external_id, stem: question.stem,
      matched_option: question.options.find((option) => match(option.text))?.text ?? null })) : [] };
}

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/functions/v1/admin-review") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const data = api(request, JSON.parse(Buffer.concat(chunks)));
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
      return;
    }
    const file = path === "/admin-review/" ? "/admin-review/index.html" : path;
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
    if (!types[extname(file)] || (path !== "/admin-review/" && !path.startsWith("/_astro/"))) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] }).end(await readFile(join(outDir, file)));
  } catch (error) {
    if (!response.headersSent) response.writeHead(500);
    response.end();
    console.error(error);
  }
});

async function waitFor(read, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

let chrome;
let socket;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const build = spawnSync(process.execPath, ["node_modules/astro/bin/astro.mjs", "build", "--outDir", outDir], {
    encoding: "utf8", timeout: 45_000, windowsHide: true,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", EXAMERFRAME_SITE_URL: "", EXAMERFRAME_BASE_PATH: "/",
      PUBLIC_SUPABASE_URL: origin, PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_staff_navigation" },
  });
  assert.equal(build.status, 0, build.error?.message ?? build.stdout + build.stderr);
  let diagnostics = "";
  chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--disable-background-networking", "--disable-gpu",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  chrome.stderr.setEncoding("utf8").on("data", (data) => { diagnostics += data; });
  chrome.once("error", (error) => { diagnostics += error.message; });
  const port = await waitFor(() => {
    assert.equal(chrome.exitCode, null, diagnostics || "Chrome exited before starting DevTools");
    return readFile(join(profile, "DevToolsActivePort"), "utf8").then((data) => data.split(/\r?\n/)[0], () => null);
  }, "Chrome DevTools");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        socket.removeEventListener("message", receive);
        reject(new Error(`Chrome DevTools timeout: ${method}`));
      }, 7000);
      function receive(event) {
        const reply = JSON.parse(event.data);
        if (reply.id !== id) return;
        clearTimeout(timeout);
        socket.removeEventListener("message", receive);
        reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result);
      }
      socket.addEventListener("message", receive);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await call("Runtime.evaluate", { expression, returnByValue: true });
    assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description);
    return response.result.value;
  }
  async function submit(selector, value) {
    const input = `document.querySelector(${JSON.stringify(selector)})`;
    await evaluate(`${input}.value = ${JSON.stringify(value)}; ${input}.form.requestSubmit();`);
  }
  const loaded = (prefix) => waitFor(() => evaluate(`document.querySelector('#staff-page').textContent.startsWith(${JSON.stringify(prefix)}) && !document.querySelector('#staff-search-form button').disabled`), prefix);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call("Page.navigate", { url: `${origin}/admin-review/` });
  await waitFor(() => evaluate("document.querySelector('#staff-login-form button')?.disabled === false"), "login form");
  assert.equal(await evaluate("document.querySelector('#staff-review').hidden"), true);
  assert.deepEqual(requests, []);
  await submit("#staff-key", "synthetic-browser-key");
  await loaded("第 1 / 3 页");
  assert.equal(await evaluate("document.querySelectorAll('.staff-card').length"), 12);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);

  await submit("#staff-jump-page", "3");
  await loaded("第 3 / 3 页");
  assert.equal(await evaluate("document.querySelectorAll('.staff-card').length"), 5);
  assert.equal(await evaluate("document.querySelector('#staff-bottom-next').disabled"), true);
  await click("#staff-bottom-prev");
  await loaded("第 2 / 3 页");
  assert.deepEqual(requests.at(-1), { action: "browse", page: 2 });
  const requestCount = requests.length;
  await submit("#staff-jump-page", "0");
  assert.equal(await evaluate("document.querySelector('#staff-jump-page').getAttribute('aria-invalid')"), "true");
  assert.equal(requests.length, requestCount);

  await submit("#staff-search", " 选项命中 %_ ");
  await loaded("第 1 / 2 页");
  assert.equal(await evaluate("document.querySelector('.staff-match-option').textContent"), "匹配选项：选项命中 %_");
  assert.deepEqual(requests.at(-1), { action: "browse", page: 1, query: "选项命中 %_" });
  await click("#staff-next");
  await loaded("第 2 / 2 页");
  assert.equal(await evaluate("document.querySelectorAll('.staff-match').length"), 2);
  await click("#staff-matches li:first-child .staff-match");
  await waitFor(() => evaluate("!!document.querySelector('.staff-card-located')"), "located search result");
  assert.equal(await evaluate("document.activeElement.id"), "staff-question-Q-013");

  await submit("#staff-search", "Q-029");
  await loaded("第 1 / 1 页");
  await click(".staff-match");
  await loaded("第 3 / 3 页");
  assert.deepEqual(requests.at(-1), { action: "browse", page: 1, external_id: "Q-029" });
  assert.equal(await evaluate("document.activeElement.id"), "staff-question-Q-029");
  assert.equal(await evaluate("!!document.activeElement.closest('.staff-card-located')"), true);
  await click(".staff-card-located input[value='high']");
  await click(".staff-card-located button[type='submit']");
  await waitFor(() => evaluate("document.querySelector('.staff-card-located [data-staff-rating-status]').textContent === '已保存：高'"), "rating saved");

  await submit("#staff-search", "二加三等于多少");
  await loaded("第 1 / 1 页");
  await click("#staff-clear-search");
  await loaded("第 3 / 3 页");
  assert.equal(await evaluate("document.querySelector('#staff-search-results').hidden"), true);
  await submit("#staff-search", "没有这个算式");
  await waitFor(() => evaluate("document.querySelector('#staff-browse-status').textContent === '没有找到匹配的题目。'"), "empty search");
  assert.equal(await evaluate("document.querySelector('#staff-jump-page').disabled"), true);
  await click("#staff-exit");
  assert.equal(await evaluate("document.querySelector('#staff-review').hidden && !document.querySelector('.staff-card')"), true);
  console.log("Staff navigation passed at 390px: page jump, literal search, paging, exact location, rating, clear, exit.");
} finally {
  socket?.close();
  if (chrome?.pid && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, delay(1500)]);
  }
  server.close();
  assert.equal(dirname(directory), tempRoot);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
