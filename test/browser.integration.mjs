import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pilotFixture } from "./support/pilot-fixture.mjs";
import { localApiConfig } from "./support/local-supabase.mjs";

// The site is served by `npm run preview`; the Edge Functions accept only the
// loopback origins from config.toml, so the page must stay on 127.0.0.1.
const site = new URL("http://127.0.0.1:4321/");
const probabilityNotice = "你的评价可能影响这道题今后被发放的概率。";
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
const fixture = await pilotFixture();
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
  const bodyText = () => page("document.body?.innerText");
  const contains = text => page("document.body?.innerText?.includes(" + JSON.stringify(text) + ")");
  const start = "#enter-lobby";
  const answer = "#submit-answer";
  const rating = "#submit-rating";
  const choice = "#answer-form input[type=radio], #answer-form input[type=checkbox]";
  const ratingChoice = "#rating-form input[type=radio]";
  const retryFailed = async label =>
    waitFor(async () => (await isEnabled(label === "answer" ? answer : rating)) && (await contains("重试")),
      "retry after failed " + label);

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
  await waitFor(() => isEnabled(start), "start button");
  if (navigationErrors.length) throw new Error(navigationErrors[0]);
  await click(start);
  participant = await waitFor(() => page(`Object.keys(localStorage).filter(k=>k.startsWith("examerframe-auth-"))
    .map(k=>JSON.parse(localStorage.getItem(k))?.user?.id).find(Boolean)`), "browser anonymous identity");
  await waitFor(() => page("!!" + selector(choice)), "first answer choices");
  assert.equal(await page("document.documentElement.scrollWidth === document.documentElement.clientWidth"), true,
    "The mobile layout must not scroll sideways");
  const stem = await page(selector("#question-stem") + "?.textContent");
  assert.ok(stem, "The first question stem is shown");

  // A failed answer keeps the selection so the user can simply retry.
  await call("Network.enable");
  await call("Network.setBlockedURLs", { urls: ["*submit-answer*"] });
  await click(choice);
  await waitFor(() => isEnabled(answer), "answer selected");
  await click(answer);
  await retryFailed("answer");
  assert.ok(await page("Array.from(document.querySelectorAll(" + JSON.stringify(choice) + ")).some(x=>x.checked)"),
    "A failed answer submission preserves the selection");
  await call("Network.setBlockedURLs", { urls: [] });
  await click(answer);
  await waitFor(() => contains(probabilityNotice), "pending rating");

  // A reload restores the server-side step and the same pending question.
  await reloadAndWait();
  await waitFor(() => contains(probabilityNotice), "restored pending rating");
  assert.equal(await page(selector("#question-stem") + "?.textContent"), stem);

  const seen = new Set([stem]);
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      await waitFor(() => page("!!" + selector(choice) + " && !" + selector(choice) + ".closest('[hidden]')"), "next question");
      const nextStem = await page(selector("#question-stem") + "?.textContent");
      assert.ok(nextStem && !seen.has(nextStem), "Each question is served once per session");
      seen.add(nextStem);
      await click(choice);
      await waitFor(() => isEnabled(answer), "next answer selected");
      await click(answer);
      await waitFor(() => contains(probabilityNotice), "next rating notice");
    }
    assert.ok(await page("document.querySelector('#review-options:not([hidden])')?.children.length"),
      "The answered question is shown for review");
    assert.equal(await page("!!document.querySelector('#rating-form input:checked')"), false, "A new rating starts empty");
    await page("document.querySelectorAll(" + JSON.stringify(ratingChoice) + ")[" + i + "]?.click()");
    await waitFor(() => isEnabled(rating), "quality selected");
    if (i === 0) {
      await call("Network.setBlockedURLs", { urls: ["*submit-rating*"] });
      await click(rating);
      await retryFailed("rating");
      assert.equal(await page("document.querySelector('#rating-form input:checked')?.value"), "low",
        "A failed rating submission preserves the chosen quality");
      await call("Network.setBlockedURLs", { urls: [] });
    }
    await click(rating);
    await waitFor(() => i === 2 ? contains("已完成") : page(`!document.querySelector("#rating-form") ||
      !!document.querySelector("#rating-form").closest("[hidden]")`), "rating advances");
  }
  await reloadAndWait();
  await waitFor(() => contains("已完成"), "restored completion");
  assert.ok((await bodyText()).includes("已完成"));
  if (navigationErrors.length) throw new Error(navigationErrors[0]);
  assert.deepEqual(networkErrors, []);
  console.log("Chrome mobile: answer retry preserves the selection, reload restores server progress, "
    + "the rating notice appears, rating retry preserves the quality and completion survives a reload.");
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
