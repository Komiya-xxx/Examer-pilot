import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectEdgeJson, localApiConfig, localDatabase, localFetch } from "./support/local-supabase.mjs";

const site = new URL("http://127.0.0.1:4321/");
const { api, publicKey } = localApiConfig();
const staffKey = process.env.EXAMERFRAME_STAFF_REVIEW_KEY;
assert.match(staffKey ?? "", /^[A-Za-z0-9_-]{43}$/, "Provide the isolated Edge runtime's test staff key");
assert.ok((await localFetch(site)).ok, "Start the configured local Astro preview first");
const allowedOrigins = new Set([site.origin, api.origin]);
const cdps = [];
const project = process.env.EXAMERFRAME_TEST_PROJECT_ID ?? "examerframe";
assert.notEqual(project, "examerframe", "Use a separate Supabase project for the v1.6 browser test");

const chromePaths = process.env.EXAMERFRAME_CHROME_PATH ? [process.env.EXAMERFRAME_CHROME_PATH] : [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
];
const chromePath = (await Promise.all(chromePaths.map((path) => access(path).then(() => path, () => null)))).find(Boolean);
assert.ok(chromePath, "Set EXAMERFRAME_CHROME_PATH to Chrome or a compatible local browser");

async function waitFor(callback, label) {
  for (let i = 0; i < 120; i++) {
    const result = await callback();
    if (result) return result;
    await delay(150);
  }
  throw new Error("Timed out: " + label);
}

async function browser() {
  const root = await realpath(tmpdir());
  const profile = await mkdtemp(join(root, "examerframe-v16-browser-"));
  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  const record = { chrome, root, profile, socket: null };
  cdps.push(record);
  const port = await waitFor(async () => {
    assert.equal(chrome.exitCode, null, "Browser exited before starting DevTools");
    return readFile(join(profile, "DevToolsActivePort"), "utf8").then((value) => value.split(/\r?\n/)[0], () => null);
  }, "Chrome DevTools port");
  const targets = await (await localFetch("http://127.0.0.1:" + port + "/json/list")).json();
  const socket = record.socket = new WebSocket(targets.find(({ type }) => type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const calls = new Map();
  const networkErrors = [];
  socket.addEventListener("message", ({ data }) => {
    const event = JSON.parse(data);
    if (event.method === "Fetch.requestPaused") {
      const { requestId, request } = event.params;
      const allowed = allowedOrigins.has(new URL(request.url).origin);
      if (!allowed) networkErrors.push("The page requested a nonlocal origin.");
      void call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" })
        .catch(() => networkErrors.push("Could not enforce local-only browser requests."));
    }
    const handle = calls.get(event.id);
    if (handle) {
      calls.delete(event.id);
      handle(event);
    }
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timeout = setTimeout(() => { calls.delete(id); reject(new Error("CDP timed out: " + method)); }, 10_000);
      calls.set(id, (reply) => {
        clearTimeout(timeout);
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error("Browser evaluation failed: " + result.exceptionDetails.text);
    return result.result.value;
  }
  const $ = (selector) => "document.querySelector(" + JSON.stringify(selector) + ")";
  const visible = (selector) => evaluate("!!" + $(selector) + " && !" + $(selector) + ".closest('[hidden]')");
  const ready = (selector) => evaluate("!!" + $(selector) + " && !" + $(selector) +
    ".closest('[hidden]') && !" + $(selector) + ".disabled");
  const text = (selector) => evaluate($(selector) + "?.textContent?.trim()");
  const click = async (selector) => {
    await waitFor(() => ready(selector), "enabled control " + selector);
    await evaluate($(selector) + ".click()");
  };
  const fill = (selector, value) => evaluate($(selector) + ".value = " + JSON.stringify(String(value)));
  await call("Fetch.enable");
  return { call, evaluate, visible, ready, text, click, fill, networkErrors };
}

const run = randomUUID().slice(0, 8);
const prefix = "v16-" + run + "-";
const external = (index) => prefix + String(index).padStart(3, "0");
const studentA = "learner-" + run + "-a";
const studentB = "learner-" + run + "-b";
const password = "Synthetic-Browser-2026!";
const note = "<b>合成反馈</b>\n第二行意见";
const quizCards = "#student-questions .student-question";
const card = (index) => quizCards + '[data-external-id="' + external(index) + '"]';
const round = randomUUID();
assert.equal(localDatabase("select count(*) from public.evaluation_rounds where status = 'open'"), "0",
  "Use an isolated local database with no open round");

localDatabase(`
  begin;
  insert into public.evaluation_rounds (id, slug, title, status, questions_per_session)
  values ('${round}', '${prefix}round', '合成用户路径验收', 'open', 10);
  insert into public.questions (external_id)
  select '${prefix}' || lpad(n::text, 3, '0') from generate_series(1, 28) n;
  insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
  select q.id, 1, case n when 2 then 'multiple_choice' when 3 then 'true_false' else 'single_choice' end,
         '合成题题干 ' || n || case when n = 25 then ' 独有检索词' else '' end,
         case when n = 3 then '[]'::jsonb else jsonb_build_array(
           jsonb_build_object('id','A','text','选项甲'),
           jsonb_build_object('id','B','text','选项乙'),
           jsonb_build_object('id','C','text',case when n = 25 then '独有选项词' else '选项丙' end)
         ) end,
         case n when 27 then 'retired' when 28 then 'draft' else 'published' end
  from generate_series(1, 28) n join public.questions q on q.external_id = '${prefix}' || lpad(n::text, 3, '0');
  insert into public.round_questions (round_id, question_id, question_version_id, is_active)
  select '${round}', q.id, v.id, q.external_id <= '${external(25)}'
  from public.questions q join public.question_versions v on v.question_id = q.id
  where q.external_id like '${prefix}%';
  insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
  select v.id, case v.question_type when 'multiple_choice' then '["C","A"]'::jsonb
    when 'true_false' then 'true'::jsonb else '"A"'::jsonb end, '版本一合成解析'
  from public.question_versions v join public.questions q on q.id = v.question_id
  where q.external_id like '${prefix}%' and q.external_id <> '${external(6)}' and v.review_status = 'published';
  insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
  select q.id, 2, v.question_type, '未启用的版本二', v.options, 'draft'
  from public.questions q join public.question_versions v on v.question_id = q.id
  where q.external_id = '${external(25)}';
  commit;
`);

async function edge(endpoint, body, token) {
  return localFetch(new URL("/functions/v1/" + endpoint, api), {
    method: "POST",
    headers: { apikey: publicKey, "Content-Type": "application/json", Origin: site.origin,
      ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body),
  });
}

async function auth(tab, name, register = false) {
  await waitFor(() => tab.ready("#student-auth-submit"), "student auth form");
  if (register) await tab.click("#student-auth-switch");
  await tab.fill("#student-username", name);
  await tab.fill("#student-password", password);
  await tab.click("#student-auth-submit");
  try {
    return await waitFor(() => tab.text("#student-account-id"), "registered account ID");
  } catch (error) {
    throw new Error(error.message + " (" + await tab.text("#student-auth-status") + ")");
  }
}

async function expectCards(tab, count, include) {
  await waitFor(async () => {
    const identifiers = await tab.evaluate(
      "[...document.querySelectorAll(" + JSON.stringify(quizCards + ":not([hidden])") + ")].map(e => e.dataset.externalId)",
    );
    return identifiers.length === count && (include === undefined || identifiers.includes(external(include)));
  }, "page cards (" + count + " rows)");
}

async function jump(tab, page, count, include) {
  await waitFor(() => tab.ready("#student-jump-page"), "page jump");
  await tab.fill("#student-jump-page", page);
  await tab.click("#student-jump-form button");
  await expectCards(tab, count, include);
}

async function choose(tab, index, values) {
  for (const value of values) await tab.click(card(index) + ' input[name="answer"][value="' + value + '"]');
  await tab.click(card(index) + " [data-submit-answer]");
}

async function loginToken(tab) {
  return tab.evaluate("JSON.parse(localStorage.getItem('examerframe-student-session'))?.access_token");
}

async function staffFeedback(tab, index, version = 1) {
  await tab.fill("#staff-feedback-id", external(index));
  await tab.fill("#staff-feedback-version", version);
  await tab.click("#staff-feedback-load");
  await waitFor(async () => (await tab.text("#staff-feedback-status")).includes("版"), "version feedback");
}

try {
  const first = await browser();
  await first.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 });
  await first.call("Page.navigate", { url: site.href });
  await first.click("#show-privacy");
  assert.ok((await first.text("#privacy")).includes("删除途径"));
  await first.click("#privacy button");
  const accountA = await auth(first, studentA, true);
  assert.match(accountA, /^[a-f0-9-]{36}$/);
  const token = await loginToken(first);
  assert.ok(token, "Registration established a browser session");

  assert.equal((await edge("student-auth", { action: "register", username: studentA.toUpperCase(), password })).status, 409);
  for (const endpoint of ["start-or-resume-session", "start-next-review-session", "submit-answer",
    "submit-rating", "submit-review-answer", "submit-review-rating"]) {
    const stale = await expectEdgeJson(await edge(endpoint, {}), 409, "old write endpoint redirects to login");
    assert.equal(stale.code, "REFRESH_AND_SIGN_IN");
  }

  const checkLayout = () => first.evaluate(`(() => {
    const bounds = [...document.querySelectorAll('.student-question')].map(e => e.getBoundingClientRect());
    return bounds.length === 12 && bounds.every((b, i) => !i ||
      (Math.abs(b.left - bounds[0].left) < 1 && b.top >= bounds[i - 1].bottom)) &&
      document.documentElement.scrollWidth === document.documentElement.clientWidth;
  })()`);
  await expectCards(first, 12, 1);
  assert.ok(await checkLayout(), "Desktop catalog is one column");
  await first.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 });
  assert.ok(await checkLayout(), "Narrow catalog is one column with no horizontal overflow");
  await jump(first, 3, 1, 25);
  assert.match(await first.text("#student-page"), /3 \/ 3 页 · 共 25 题/);
  assert.match(await first.text(card(25) + " [data-identifier]"), /第 1 版/);
  await jump(first, 2, 12, 13);

  for (const term of [external(25), "独有检索词", "独有选项词"]) {
    await first.fill("#student-search", term);
    await first.click("#student-search-form [type=submit]");
    await waitFor(() => first.ready(".student-match"), "search result");
    assert.equal(await first.evaluate("document.querySelectorAll('.student-match').length"), 1);
    await first.click(".student-match");
    await expectCards(first, 1, 25);
    assert.equal(await first.evaluate("document.activeElement?.closest('[data-external-id]')?.dataset.externalId"), external(25));
  }
  const untouched = await expectEdgeJson(await edge("student-practice", { action: "browse", page: 3 }, token), 200, "catalog JSON");
  assert.equal(untouched.questions[0].response, null);
  assert.equal("standard_answer" in untouched.questions[0], false);
  assert.equal(localDatabase("select count(*) from examerframe_private.student_responses"), "0");
  assert.equal(localDatabase("select count(*) from public.session_questions"), "0");
  console.log("Passed catalog navigation, search, zero side effects, and 1440px/390px single-column layout");

  await jump(first, 1, 12, 1);
  for (const [number, values, result] of [
    [1, ["A"], "correct"], [2, ["A", "C"], "correct"], [3, ["true"], "correct"],
    [4, ["A"], "correct"], [5, ["B"], "wrong"], [6, ["A"], "ungraded"],
  ]) {
    await choose(first, number, values);
    await waitFor(() => first.visible(card(number) + ' [data-result="' + result + '"]'), "submitted answer " + number);
  }
  assert.equal(await first.text("#student-accuracy"), "4/5（80%）");
  assert.equal(await first.text("#student-unanswered"), "6");
  await first.click("#student-wrong-only");
  await expectCards(first, 1, 5);
  await first.click("#student-wrong-only");

  for (const [index, quality] of [[1, "low"], [2, "high"], [5, "low"]]) {
    await first.click(card(index) + ' [data-rating="' + quality + '"]');
    await waitFor(() => first.text(card(index) + " [data-saved-rating]"), "saved quality");
  }
  await first.fill(card(3) + " [data-comment-input]", "    ");
  await first.click(card(3) + " [data-comment-form] button");
  assert.match(await first.text(card(3) + " [data-feedback-status]"), /请填写/);
  for (const [index, comment] of [[3, "仅提交文字"], [1, note]]) {
    await first.fill(card(index) + " [data-comment-input]", comment);
    await first.click(card(index) + " [data-comment-form] button");
    await waitFor(() => first.visible(card(index) + " [data-saved-comment]"), "saved comment");
  }
  assert.equal(await first.evaluate("document.querySelector('[data-saved-comment] b') === null"), true);
  const before = await expectEdgeJson(await edge("student-practice", { action: "browse", page: 1 }, token), 200, "own answers");
  const responses = before.questions.map((question) => question.response);
  assert.equal(responses[2].rating, null);
  assert.equal(responses[3].rating, null);
  assert.equal(responses[3].comment, null);
  assert.equal((await edge("student-practice", { action: "comment", response_id: responses[0].id, comment: note }, token)).status, 200);
  assert.equal((await edge("student-practice", { action: "rate", response_id: responses[3].id, quality: "medium" }, token)).status, 400);
  assert.equal(localDatabase("select count(*) from examerframe_private.student_response_comments"), "2");
  assert.equal(localDatabase("select count(*) from public.ratings"), "0");

  await first.click("#student-mistakes");
  await expectCards(first, 1, 5);
  await first.click(card(5) + " [data-open-review]");
  await waitFor(() => first.visible(card(5) + " [data-verdict-panel]"), "mistake details");
  assert.match(await first.text(card(5) + " [data-review-time]"), /最近回看/);
  await first.click(card(5) + " [data-start-retry]");
  assert.equal(await first.visible(card(5) + " [data-verdict-panel]"), false);
  await choose(first, 5, ["A"]);
  await waitFor(async () => (await first.text(card(5) + " [data-retry-result]")).includes("答对"), "retry result");
  assert.equal(await first.text(card(5) + " [data-verdict]"), "答错");
  assert.match(await first.text(card(5) + " [data-saved-rating]"), /低/);
  await first.click("#student-catalog");
  await expectCards(first, 12, 1);
  await jump(first, 3, 1, 25);
  const resume = () => edge("student-practice", { action: "browse", page: null }, token);
  try {
    await waitFor(async () => {
      const result = await resume();
      return result.ok && (await result.json()).page === 3;
    }, "resumable position on page 3");
  } catch (error) {
    const result = await resume();
    const position = await result.json();
    throw new Error(error.message + " (API " + result.status + ", page " + (position.page ?? "unavailable") +
      ", browser status: " + await first.text("#student-browse-status") + ")");
  }
  await first.click("#student-sign-out");
  await waitFor(() => first.ready("#student-auth-submit"), "logged out");
  assert.equal(await first.evaluate("document.querySelectorAll('.student-question').length"), 0);

  const second = await browser();
  await second.call("Page.navigate", { url: site.href });
  assert.equal(await auth(second, studentA.toUpperCase()), accountA, "Different browser recovered the same ID");
  await expectCards(second, 1, 25);
  assert.equal(await second.evaluate("document.activeElement?.closest('[data-external-id]')?.dataset.externalId"), external(25));
  await jump(second, 1, 12, 5);
  assert.equal(await second.text("#student-accuracy"), "4/5（80%）");
  await second.call("Page.reload", { ignoreCache: true });
  await waitFor(() => second.text("#student-account-id").then((id) => id === accountA, () => false), "session on reload");
  await second.click("#student-mistakes");
  await second.click(card(5) + " [data-open-review]");
  await waitFor(() => second.visible(card(5) + " [data-retry-result]"), "recovered retry");
  assert.match(await second.text(card(5) + " [data-retry-result]"), /答对/);
  assert.match(await second.text(card(5) + " [data-saved-rating]"), /低/);
  await second.click("#student-sign-out");
  await waitFor(() => second.ready("#student-auth-submit"), "account switch");
  assert.notEqual(await auth(second, studentB, true), accountA);
  await expectCards(second, 12, 5);
  assert.equal(await second.text("#student-answered"), "0");
  assert.equal(await second.visible(card(5) + " [data-verdict-panel]"), false);
  const tokenB = await loginToken(second);
  assert.equal((await edge("student-practice", { action: "review", response_id: responses[4].id }, tokenB)).status, 404);
  await second.click("#student-mistakes");
  await waitFor(async () => (await second.text("#student-browse-status")).includes("还没有错题"), "account B is isolated");
  const parallelAnswer = {
    action: "answer", question_version_id: before.questions[6].question_version_id, answer: "A",
  };
  const attempts = await Promise.all([edge("student-practice", parallelAnswer, tokenB),
    edge("student-practice", parallelAnswer, tokenB)]);
  const saved = await Promise.all(attempts.map((response) => expectEdgeJson(response, 200, "concurrent first answer replay")));
  assert.equal(saved[0].response.id, saved[1].response.id);
  console.log("Passed separate-browser recovery, account isolation, distinct grading states, and immutable first answer");

  localDatabase(`
    update public.round_questions set is_active = false
    where round_id = '${round}' and question_version_id = '${before.questions[4].question_version_id}';
    update public.question_versions set review_status = 'retired' where id = '${before.questions[4].question_version_id}';
    update public.evaluation_rounds set status = 'closed' where id = '${round}';
  `);
  assert.equal(await auth(first, studentA), accountA);
  await waitFor(async () => (await first.text("#student-browse-status")).includes("没有开放"), "closed catalog");
  const replay = await expectEdgeJson(await edge("student-practice", {
    action: "answer", question_version_id: before.questions[4].question_version_id, answer: "B",
  }, await loginToken(first)), 200, "replay retains delisted first answer");
  assert.equal(replay.response.id, responses[4].id);
  await first.click("#student-history");
  await expectCards(first, 6, 1);
  assert.equal(await first.text(card(1) + " [data-verdict]"), "答对");
  assert.match(await first.text(card(1) + " [data-saved-rating]"), /低/);
  assert.equal(await first.text(card(6) + " [data-verdict]"), "暂不可判");
  await first.click("#student-mistakes");
  await first.click(card(5) + " [data-open-review]");
  await waitFor(() => first.visible(card(5) + " [data-verdict-panel]"), "delisted original question details");
  assert.equal(await first.text(card(5) + " [data-explanation]"), "版本一合成解析");

  await second.call("Page.navigate", { url: new URL("admin-review/", site).href });
  await waitFor(() => second.ready("#staff-login-form button[type=submit]"), "staff login");
  await second.fill("#staff-key", staffKey);
  await second.click("#staff-login-form button[type=submit]");
  await waitFor(() => second.visible("#staff-feedback-form"), "authorized student feedback");
  await staffFeedback(second, 1);
  assert.equal(await second.text("#staff-feedback-low"), "1");
  assert.equal(await second.text("#staff-feedback-comment-count"), "1");
  assert.equal(await second.text("#staff-feedback-comments li p"), note);
  assert.equal(await second.evaluate("document.querySelector('#staff-feedback-comments b') === null"), true);
  await staffFeedback(second, 2);
  assert.equal(await second.text("#staff-feedback-high"), "1");
  await staffFeedback(second, 3);
  assert.equal(await second.text("#staff-feedback-low"), "0");
  assert.equal(await second.text("#staff-feedback-high"), "0");
  assert.equal(await second.text("#staff-feedback-comment-count"), "1");
  await staffFeedback(second, 4);
  assert.match(await second.text("#staff-feedback-status"), /暂无学生反馈/);
  await staffFeedback(second, 5);
  assert.equal(await second.text("#staff-feedback-low"), "1", "Editor can retrieve a retired version");
  await second.click("#staff-exit");
  assert.equal(await second.text("#staff-feedback-comments"), "");
  assert.deepEqual([...first.networkErrors, ...second.networkErrors], []);
  console.log("Passed low/high votes, text-only and skipped feedback, exact-version editor access, and retired question replay");
} finally {
  for (const { chrome, socket, profile, root } of cdps) {
    socket?.close();
    if (chrome.pid && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await Promise.race([exited, delay(2500)]);
    }
    if (dirname(profile) === root && basename(profile).startsWith("examerframe-v16-browser-")) {
      await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }).catch(() => {});
    }
  }
  localDatabase(`
    begin;
    delete from auth.users where raw_app_meta_data->>'examerframe_username' in ('${studentA}', '${studentB}');
    delete from public.round_questions where round_id = '${round}';
    delete from public.evaluation_rounds where id = '${round}';
    delete from examerframe_private.question_feedback
      where question_version_id in (select v.id from public.question_versions v join public.questions q
        on q.id = v.question_id where q.external_id like '${prefix}%');
    delete from public.question_versions where question_id in (
      select id from public.questions where external_id like '${prefix}%'
    );
    delete from public.questions where external_id like '${prefix}%';
    commit;
  `);
}
