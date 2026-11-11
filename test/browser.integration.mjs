import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pilotFixture } from "./support/pilot-fixture.mjs";
import { localApiConfig, localDatabase } from "./support/local-supabase.mjs";

// The site is served by `npm run preview`; the Edge Functions accept only the
// loopback origins from config.toml, so the page must stay on 127.0.0.1.
const site = new URL("http://127.0.0.1:4321/");
const purposeNotice = "我们汇总评价，筛选适合后续正式题库的题目。";
const candidateChromePaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const unavailable = "Browser check needs a local site at " + site.origin + " and Chrome. "
  + "Run `npm run build && npm run preview`, then set EXAMERFRAME_CHROME_PATH to a Chrome executable.";

async function executable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findChrome() {
  const configured = process.env.EXAMERFRAME_CHROME_PATH;
  if (configured) {
    return await executable(configured) ? configured : null;
  }
  for (const candidate of candidateChromePaths) {
    if (await executable(candidate)) return candidate;
  }
  return null;
}

function siteServing() {
  return fetch(site, { redirect: "error", signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok, () => false);
}

if (!(await siteServing())) {
  console.error(unavailable + " Nothing is listening on " + site.origin + ".");
  process.exit(1);
}
const chromePath = await findChrome();
if (!chromePath) {
  console.error(unavailable + (process.env.EXAMERFRAME_CHROME_PATH
    ? " EXAMERFRAME_CHROME_PATH does not point to an executable."
    : " No Chrome was found in its usual location."));
  process.exit(1);
}

const localOrigins = new Set([site.origin, localApiConfig().api.origin]);
const fixture = await pilotFixture({ feedback: true });
async function waitFor(callback, label) {
  for (let i = 0; i < 75; i += 1) {
    const result = await callback();
    if (result) return result;
    await delay(200);
  }
  throw new Error("Timed out: " + label);
}
let socket;
let participant;
let chrome;
let profile;
let tempRoot;
try {
  tempRoot = await realpath(tmpdir());
  profile = await mkdtemp(join(tempRoot, "examerframe-browser-"));
  // Load the test page only after network requests are pinned to localhost.
  chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const port = await waitFor(async () => {
    try { return (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; }
    catch { return null; }
  }, "Chrome DevTools port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const calls = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    const callback = calls.get(reply.id);
    if (callback) {
      calls.delete(reply.id);
      callback(reply);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => reject(new Error("CDP " + method + " timed out")), 8000);
    calls.set(id, reply => {
      clearTimeout(timeout);
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const page = async expression => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true });
    return result.exceptionDetails ? undefined : result.result.value;
  };
  async function reloadAndWait() {
    const previous = await page("performance.timeOrigin");
    await call("Page.reload", { ignoreCache: true });
    await waitFor(() => page("performance.timeOrigin")
      .then(current => Number.isFinite(current) && current !== previous, () => false),
    "new document after reload");
  }

  const selector = s => "document.querySelector(" + JSON.stringify(s) + ")";
  const click = s => page(selector(s) + "?.click()");
  function enabled(s) {
    return "!!" + selector(s) + " && !" + selector(s) + ".disabled && !" + selector(s) + ".closest('[hidden]')";
  }
  const isEnabled = s => page(enabled(s));
  const contains = text => page("document.body?.innerText?.includes(" + JSON.stringify(text) + ")");
  const submit = "#submit-answer";
  const choice = '#answer-options input[name="answer"]';
  const rating = (value) => `#rating-options input[value="${value}"]`;
  const chosen = () => page('document.querySelector(\'#rating-options input:checked\')?.value ?? null');
  const questionVisible = () => page("!!document.querySelector('#current-question:not([hidden])')");
  const position = (number) => page(selector("#question-progress") + "?.textContent === " + JSON.stringify(`第 ${number} 题`));
  const retryFailed = async label => waitFor(
    async () => (await isEnabled(submit)) && (await contains("重试")), "retry after failed " + label,
  );
  // The page must never leave the configured local origin, including its own
  // redirects. Wire a navigation hook before the first navigate so any off-origin
  // navigation is caught and fails the run immediately.
  const networkErrors = [];
  socket.addEventListener("message", ({ data }) => {
    const { method, params } = JSON.parse(data);
    if (method !== "Fetch.requestPaused") return;
    const { requestId, request } = params;
    const allowed = localOrigins.has(new URL(request.url).origin);
    if (!allowed) networkErrors.push("The page requested a nonlocal origin.");
    const operation = allowed ? "Fetch.continueRequest" : "Fetch.failRequest";
    void call(operation, allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" })
      .catch(() => networkErrors.push("Could not enforce local-only browser requests."));
  });
  await call("Fetch.enable");

  const navigationErrors = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Page.navigatedWithinDocument" || message.method === "Page.frameNavigated") {
      const url = message.params?.frame?.url ?? message.params?.url;
      if (url && new URL(url).origin !== site.origin) {
        navigationErrors.push("Chrome navigated off the local origin to " + url);
      }
    }
  });

  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 });
  await call("Page.navigate", { url: site.href });
  await waitFor(() => page("document.querySelector('#privacy')?.open"), "first-visit privacy notice");
  assert.ok(await contains(purposeNotice));
  participant = await waitFor(() => page('Object.keys(localStorage).filter(k=>k.startsWith("examerframe-auth-"))'
    + '.map(k=>JSON.parse(localStorage.getItem(k))?.user?.id).find(Boolean)'), "automatic anonymous identity");
  await waitFor(questionVisible, "automatic first question without clicking Start");
  assert.equal(await page("document.querySelector('#enter-lobby')?.hidden"), true);
  await click("#dismiss-privacy");
  await waitFor(() => page("!document.querySelector('#privacy')?.open"), "dismissed notice");
  assert.equal(await page("document.documentElement.scrollWidth === document.documentElement.clientWidth"), true,
    "The mobile layout must not scroll sideways");
  assert.deepEqual(await page("[...document.querySelectorAll('[data-practice-type]')].map(button=>button.textContent)"),
    ["选择题", "填空题", "判断题", "名词解释", "更新中"]);
  await click('[data-practice-type="fill"]');
  assert.ok(await contains("填空题正在准备"));
  assert.ok(await position(1), "Future type options do not change the assigned session");
  assert.equal(await page("document.querySelectorAll('.question-map button').length"), 3);
  assert.equal(await page("document.querySelector('#answer-review').hidden"), true);
  assert.equal(await page("document.querySelector('#rating-options').hidden"), true);

  const go = number => click("#question-map button[data-position='" + number + "']");
  const result = () => page("document.querySelector('#answer-review:not([hidden])')?.dataset.result");
  const selectedAnswer = () => page("[...document.querySelectorAll('#answer-options input:checked')].map(x=>x.value)");
  const pick = value => click(choice + "[value='" + value + "']");
  async function selectAnswer(correct) {
    const type = await page("document.querySelector('#question-type').textContent");
    if (type === "判断题") await pick(correct ? "true" : "false");
    else if (type === "多选题" && correct) { await pick("A"); await pick("C"); }
    else await pick(correct ? "A" : "B");
  }

  await selectAnswer(false);
  const firstDraft = await selectedAnswer();
  await go(3);
  assert.ok(await position(3), "An unanswered first question does not block navigation");
  assert.equal(await result(), undefined, "Skipping to an unanswered question does not reveal its solution");
  await selectAnswer(true);
  const thirdDraft = await selectedAnswer();
  await call("Network.enable");
  await call("Network.setBlockedURLs", { urls: ["*submit-review-answer*"] });
  await click(submit);
  await retryFailed("answer");
  assert.deepEqual(await selectedAnswer(), thirdDraft);
  assert.equal(await result(), undefined, "Failed submission does not reveal the solution");
  await call("Network.setBlockedURLs", { urls: [] });
  await click(submit);
  await waitFor(async () => (await result()) === "correct", "animated correct result");
  assert.ok(await page("document.querySelector('#answer-review').classList.contains('play-feedback')"));
  assert.ok(await contains("本地合成题解析。"));
  assert.ok(await contains("您的评价将会改善后续的题目质量"));
  assert.ok(await position(3), "Submission stays on the same question to show feedback");
  assert.equal(await chosen(), null, "Default medium does not impersonate an active choice");

  await click(rating("high"));
  assert.ok(await contains("今后更有机会发放"));
  await call("Network.setBlockedURLs", { urls: ["*submit-review-rating*"] });
  await click("#save-rating");
  await waitFor(async () => (await isEnabled("#save-rating")) && (await contains("评价尚未确认")), "rating retry");
  assert.equal(await chosen(), "high");
  await call("Network.setBlockedURLs", { urls: [] });
  await click("#save-rating");
  await waitFor(() => contains("已记录：「高」"), "explicit rating recorded");

  await go(1);
  assert.deepEqual(await selectedAnswer(), firstDraft, "Jumping preserves the first unsent answer");
  assert.equal(await page("document.querySelector('[data-position=\"3\"]').closest('li').dataset.state"), "done");
  assert.equal(await page("document.querySelector('[data-position=\"2\"]').closest('li').dataset.state"), "upcoming");
  await click(submit);
  await waitFor(async () => (await result()) === "incorrect", "animated incorrect result");
  assert.ok(await page("document.querySelector('#answer-review').classList.contains('play-feedback')"));
  assert.ok(await contains("这题答错了"));
  await go(2);
  assert.equal(await result(), undefined);
  await selectAnswer(true);
  await click(submit);
  await waitFor(() => contains("全部作答完成"), "completion without an explicit rating on every question");

  await go(3);
  assert.equal(await result(), "correct");
  assert.ok(!(await page("document.querySelector('#answer-review').classList.contains('play-feedback')")),
    "A revisit does not replay the submission animation");
  await reloadAndWait();
  await waitFor(async () => (await position(3)) && (await result()) === "correct", "restored review after reload");
  assert.ok(await contains("已记录：「高」"));
  assert.equal(await page("document.querySelector('#privacy')?.open"), false, "Dismissed notice stays closed");

  const uuid = /^[0-9a-f-]{36}$/;
  assert.match(participant, uuid);
  assert.match(fixture.round, uuid);
  assert.equal(localDatabase(
    "select string_agg(t.quality || ':' || t.source, ',' order by a.position) "
    + "from public.sessions s join public.session_questions a on a.session_id=s.id "
    + "join public.responses r on r.session_question_id=a.id join public.ratings t on t.response_id=r.id "
    + "where s.participant_id='" + participant + "' and s.round_id='" + fixture.round + "'"
  ), "medium:default,medium:default,high:explicit", "Default and learner ratings are distinguishable");
  if (navigationErrors.length) throw new Error(navigationErrors[0]);
  assert.deepEqual(networkErrors, []);
  console.log("Chrome mobile: free navigation, correct and incorrect feedback, retries, restored review, and default versus explicit ratings passed.");
} finally {
  socket?.close();
  chrome?.kill();
  fixture.cleanup(participant);
  if (profile) {
    const resolved = await realpath(profile);
    assert.equal(dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
    assert.ok(basename(resolved).startsWith("examerframe-browser-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}
