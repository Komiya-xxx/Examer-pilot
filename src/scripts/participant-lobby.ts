import { createClient, type Session } from "@supabase/supabase-js";
import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from "astro:env/client";
import { renderStudentQuestion, type QuestionAction, type StudentQuestion } from "./student-question";

type Account = { id: string; username: string };
type SignIn = { access_token: string; refresh_token: string; account: Account };
type Match = { external_id: string; stem: string; matched_option: string | null };
type Page = { page: number; total_count: number; total_pages: number; questions: StudentQuestion[];
  matches?: Match[]; focus_version_id?: string | null };
type Navigation = { action: "browse"; page: number | null; query?: string; external_id?: string }
  | { action: "wrong" | "answered"; page: number };

class StudentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const storageKey = "examerframe-student-session";
const client = PUBLIC_SUPABASE_URL && PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ? createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { storageKey, detectSessionInUrl: false },
  }) : null;

function element<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

const authPanel = element("student-auth");
const authForm = element<HTMLFormElement>("student-auth-form");
const username = element<HTMLInputElement>("student-username");
const password = element<HTMLInputElement>("student-password");
const authSubmit = element<HTMLButtonElement>("student-auth-submit");
const authSwitch = element<HTMLButtonElement>("student-auth-switch");
const reconnect = element<HTMLButtonElement>("student-reconnect");
const authStatus = element("student-auth-status");
const practice = element("student-practice");
const accountName = element("student-account-name");
const accountId = element("student-account-id");
const signOut = element<HTMLButtonElement>("student-sign-out");
const catalog = element<HTMLButtonElement>("student-catalog");
const history = element<HTMLButtonElement>("student-history");
const mistakes = element<HTMLButtonElement>("student-mistakes");
const browseStatus = element("student-browse-status");
const browseRetry = element<HTMLButtonElement>("student-browse-retry");
const search = element<HTMLFormElement>("student-search-form");
const query = element<HTMLInputElement>("student-search");
const searchSubmit = search.querySelector<HTMLButtonElement>('[type="submit"]')!;
const clearSearch = element<HTMLButtonElement>("student-clear-search");
const jump = element<HTMLFormElement>("student-jump-form");
const pageInput = element<HTMLInputElement>("student-jump-page");
const jumpSubmit = jump.querySelector<HTMLButtonElement>('[type="submit"]')!;
const previous = ["student-prev", "student-bottom-prev"].map(element<HTMLButtonElement>);
const next = ["student-next", "student-bottom-next"].map(element<HTMLButtonElement>);
const previousNext = [...previous, ...next];
const searchResults = element("student-search-results");
const matchList = element("student-matches");
const cards = element("student-questions");
const summary = element("student-summary");
const filter = element<HTMLInputElement>("student-wrong-only");
const template = element<HTMLTemplateElement>("student-question-template");

let account: Account | null = null;
let authAction: "login" | "register" = "login";
let authBusy = false;
let authGeneration = 0;
let loading = false;
let pendingWrites = 0;
let current: Navigation = { action: "browse", page: null };
let catalogPage = 1;
let page: Page = { page: 1, total_count: 0, total_pages: 0, questions: [] };
let failedNavigation: Navigation | null = null;
let pendingPosition: string | null = null;
let savedPosition: string | null = null;
let savingPosition = false;

function failureMessage(error: unknown) {
  return error instanceof StudentError ? error.message : "连接失败，请重试。";
}

async function post<T>(endpoint: "student-auth" | "student-practice", body: object, token?: string): Promise<T> {
  if (!PUBLIC_SUPABASE_URL || !PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new StudentError("此站点尚未配置复习服务。", "NO_CONFIG");
  }
  const headers = new Headers({ "Content-Type": "application/json", apikey: PUBLIC_SUPABASE_PUBLISHABLE_KEY });
  if (token) headers.set("Authorization", "Bearer " + token);
  const response = await fetch(new URL("/functions/v1/" + endpoint, PUBLIC_SUPABASE_URL), {
    method: "POST", body: JSON.stringify(body), headers,
    cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new StudentError(typeof data?.message === "string" ? data.message : "复习服务暂不可用，请稍后重试。",
      typeof data?.code === "string" ? data.code : "SERVICE_UNAVAILABLE");
  }
  return data as T;
}

async function request<T>(owner: Account, operation: object): Promise<T> {
  const session = (await client?.auth.getSession())?.data.session;
  if (!session || session.user.id !== owner.id || account !== owner) {
    throw new StudentError("登录会话已失效，请重新登录。", "UNAUTHORIZED");
  }
  return post<T>("student-practice", operation, session.access_token);
}

function drawAuth() {
  const registering = authAction === "register";
  element("student-auth-title").textContent = registering ? "注册学生账户" : "学生登录";
  authSubmit.textContent = registering ? "注册并登录" : "登录";
  authSwitch.textContent = registering ? "返回登录" : "注册新账户";
  element("student-auth-help").hidden = !registering;
  password.autocomplete = registering ? "new-password" : "current-password";
  authSubmit.disabled = authSwitch.disabled = !client || authBusy;
  username.readOnly = password.readOnly = authBusy;
  reconnect.disabled = authBusy;
}

function clearAccount(message = "") {
  authGeneration += 1;
  account = null;
  authAction = "login";
  loading = false;
  pendingWrites = 0;
  current = { action: "browse", page: null };
  page = { page: 1, total_count: 0, total_pages: 0, questions: [] };
  catalogPage = 1;
  failedNavigation = null;
  pendingPosition = savedPosition = null;
  savingPosition = false;
  cards.replaceChildren();
  matchList.replaceChildren();
  accountName.textContent = accountId.textContent = "";
  browseStatus.textContent = "";
  query.value = pageInput.value = username.value = password.value = "";
  filter.checked = false;
  updateSummary();
  practice.hidden = true;
  authPanel.hidden = false;
  reconnect.hidden = true;
  authStatus.textContent = message;
  drawAuth();
}

async function leave(message: string) {
  if (authBusy) return;
  authBusy = true;
  clearAccount(message);
  try {
    const result = await client?.auth.signOut({ scope: "local" });
    if (result?.error) localStorage.removeItem(storageKey);
  } catch {
    try { localStorage.removeItem(storageKey); } catch { /* Storage unavailable */ }
  } finally {
    authBusy = false;
    drawAuth();
    username.focus();
  }
}

function reportPractice(error: unknown, owner: Account) {
  if (account === owner && error instanceof StudentError &&
    (error.code === "UNAUTHORIZED" || error.code === "STUDENT_ACCOUNT_REQUIRED")) {
    void leave(error.message);
  }
  return failureMessage(error);
}

function enter(profile: Account) {
  account = profile;
  accountName.textContent = profile.username;
  accountId.textContent = profile.id;
  authPanel.hidden = true;
  practice.hidden = false;
  element("student-practice-title").focus({ preventScroll: true });
  void navigate({ action: "browse", page: null });
}

async function restore(provided?: Session) {
  if (!client || authBusy) return;
  const generation = ++authGeneration;
  authBusy = true;
  authStatus.textContent = "正在检查登录状态…";
  drawAuth();
  try {
    const session = provided ?? (await client.auth.getSession()).data.session;
    if (generation !== authGeneration) return;
    if (session) {
      const profile = await post<Account>("student-practice", { action: "profile" }, session.access_token);
      if (generation !== authGeneration) return;
      authStatus.textContent = "";
      authBusy = false;
      enter(profile);
    } else {
      authStatus.textContent = "";
    }
  } catch (error) {
    if (generation !== authGeneration) return;
    if (error instanceof StudentError && ["UNAUTHORIZED", "STUDENT_ACCOUNT_REQUIRED"].includes(error.code)) {
      authBusy = false;
      await leave(error.message);
    } else {
      authStatus.textContent = failureMessage(error);
      reconnect.hidden = false;
    }
  } finally {
    authBusy = false;
    drawAuth();
  }
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client || authBusy) return;
  const generation = ++authGeneration;
  authBusy = true;
  reconnect.hidden = true;
  drawAuth();
  authStatus.textContent = authAction === "register" ? "正在注册…" : "正在登录…";
  try {
    const signedIn = await post<SignIn>("student-auth", { action: authAction, username: username.value, password: password.value });
    if (generation !== authGeneration) return;
    const { data, error } = await client.auth.setSession({
      access_token: signedIn.access_token, refresh_token: signedIn.refresh_token,
    });
    if (generation !== authGeneration) return;
    if (error || data.user?.id !== signedIn.account.id) {
      throw new StudentError("登录会话未能建立，请重新登录。", "UNAUTHORIZED");
    }
    password.value = "";
    authStatus.textContent = "";
    authBusy = false;
    enter(signedIn.account);
  } catch (error) {
    if (generation === authGeneration) authStatus.textContent = failureMessage(error);
  } finally {
    authBusy = false;
    drawAuth();
  }
});
authSwitch.addEventListener("click", () => {
  authAction = authAction === "login" ? "register" : "login";
  password.value = "";
  authStatus.textContent = "";
  drawAuth();
  username.focus();
});
reconnect.addEventListener("click", () => { void restore(); });
signOut.addEventListener("click", () => { void leave("已退出登录。"); });
client?.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT" && !authBusy && account) clearAccount("请登录学生账户。");
  if (event === "SIGNED_IN" && account && session && account.id !== session.user.id) {
    clearAccount();
    window.setTimeout(() => { void restore(session); }, 0);
  }
});

function updateNavigation() {
  const busy = loading || pendingWrites > 0;
  const inCatalog = current.action === "browse";
  const searching = current.action === "browse" && !!current.query;
  catalog.disabled = history.disabled = mistakes.disabled = busy;
  catalog.setAttribute("aria-pressed", String(inCatalog));
  history.setAttribute("aria-pressed", String(current.action === "answered"));
  mistakes.setAttribute("aria-pressed", String(current.action === "wrong"));
  search.hidden = !inCatalog;
  query.readOnly = busy;
  searchSubmit.disabled = clearSearch.disabled = busy;
  clearSearch.hidden = !searching;
  pageInput.max = String(page.total_pages);
  pageInput.disabled = jumpSubmit.disabled = busy || page.total_pages === 0;
  for (const button of previous) button.disabled = busy || page.page <= 1;
  for (const button of next) button.disabled = busy || page.page >= page.total_pages;
  for (const button of matchList.querySelectorAll("button")) button.disabled = busy;
  element("student-bottom-pager").hidden = page.total_pages <= 1;
  browseRetry.hidden = !failedNavigation;
  browseRetry.disabled = busy;
}

function updateSummary() {
  const showingCatalog = current.action === "browse" && !current.query && page.questions.length > 0;
  summary.hidden = !showingCatalog;
  let correct = 0;
  let wrong = 0;
  let ungraded = 0;
  for (const question of page.questions) {
    if (!question.response) continue;
    if (question.response.correct === true) correct += 1;
    else if (question.response.correct === false) wrong += 1;
    else ungraded += 1;
  }
  const answered = correct + wrong + ungraded;
  const gradable = correct + wrong;
  element("student-answered").textContent = String(answered);
  element("student-correct").textContent = String(correct);
  element("student-wrong-count").textContent = String(wrong);
  element("student-ungraded").textContent = String(ungraded);
  element("student-unanswered").textContent = String(page.questions.length - answered);
  element("student-accuracy").textContent = gradable
    ? correct + "/" + gradable + "（" + Math.round(correct * 100 / gradable) + "%）"
    : "暂无可判分题";
  const filtering = showingCatalog && filter.checked;
  for (const [index, card] of Array.from(cards.children).entries()) {
    (card as HTMLElement).hidden = filtering && page.questions[index]?.response?.correct !== false;
  }
  element("student-filter-status").hidden = !filtering || wrong > 0;
}

async function saveQuestion(owner: Account, operation: QuestionAction) {
  if (loading || account !== owner) throw new StudentError("请稍候再试。", "BUSY");
  pendingWrites += 1;
  updateNavigation();
  try {
    const saved = await request<StudentQuestion>(owner, operation);
    if (account === owner) {
      const index = page.questions.findIndex(({ question_version_id }) => question_version_id === saved.question_version_id);
      if (index !== -1) page.questions[index] = saved;
      updateSummary();
    }
    return saved;
  } finally {
    if (account === owner) {
      pendingWrites -= 1;
      updateNavigation();
    }
  }
}

async function remember(owner: Account, versionId: string) {
  if (account !== owner || loading || (versionId === savedPosition && !savingPosition)) return;
  pendingPosition = versionId;
  if (savingPosition) return;
  savingPosition = true;
  try {
    while (account === owner && pendingPosition) {
      const nextPosition = pendingPosition;
      pendingPosition = null;
      if (nextPosition !== savedPosition) {
        await request(owner, { action: "position", question_version_id: nextPosition });
        if (account === owner) savedPosition = nextPosition;
      }
    }
  } catch (error) {
    if (account === owner) browseStatus.textContent = reportPractice(error, owner);
  } finally {
    if (account === owner) savingPosition = false;
  }
}

function renderMatch(result: Match) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.className = "student-match";
  const id = document.createElement("strong");
  id.textContent = result.external_id;
  const stem = document.createElement("span");
  stem.textContent = result.stem;
  button.append(id, stem);
  if (result.matched_option !== null) {
    const option = document.createElement("span");
    option.textContent = "匹配选项 " + result.matched_option;
    button.append(option);
  }
  button.addEventListener("click", () => {
    filter.checked = false;
    void navigate({ action: "browse", page: null, external_id: result.external_id });
  });
  item.append(button);
  return item;
}

async function navigate(target: Navigation, rememberPage = false) {
  const owner = account;
  if (!owner || loading || pendingWrites > 0) return;
  failedNavigation = null;
  loading = true;
  updateNavigation();
  browseStatus.textContent = "正在载入…";
  try {
    const incoming = await request<Page>(owner, target);
    if (account !== owner) return;
    page = incoming;
    current = target;
    const inCatalog = target.action === "browse";
    const queryText = inCatalog ? target.query ?? "" : "";
    if (inCatalog && !queryText) catalogPage = page.page;
    if (inCatalog) query.value = queryText;
    pageInput.value = "";
    element("student-page").textContent =
      "第 " + (page.total_pages ? page.page : 0) + " / " + page.total_pages + " 页 · 共 " + page.total_count + " 题";
    browseStatus.textContent = page.total_count ? "" : queryText ? "没有匹配的题目。"
      : inCatalog ? "目前没有开放的练习题。" : target.action === "wrong" ? "还没有错题。" : "还没有作答记录。";
    searchResults.hidden = !queryText || !page.total_count;
    matchList.replaceChildren(...(page.matches ?? []).map(renderMatch));
    cards.replaceChildren(...page.questions.map((question) => renderStudentQuestion(
      template, question, target.action === "wrong", (operation) => saveQuestion(owner, operation),
      inCatalog ? () => { void remember(owner, question.question_version_id); } : undefined,
      (error) => reportPractice(error, owner),
    )));
    updateSummary();

    if (page.focus_version_id) {
      const targetHeading = document.getElementById("student-question-" + page.focus_version_id);
      targetHeading?.focus({ preventScroll: true });
      targetHeading?.scrollIntoView({ block: "start" });
      if (target.action === "browse" && !target.external_id) savedPosition = page.focus_version_id;
    } else if (queryText && page.total_count) {
      element("student-results-title").focus({ preventScroll: true });
    }
  } catch (error) {
    if (account === owner) {
      failedNavigation = target;
      browseStatus.textContent = reportPractice(error, owner);
    }
  } finally {
    if (account === owner) {
      loading = false;
      updateNavigation();
      if (target.action === "browse" && !target.query && !failedNavigation && (target.external_id || rememberPage)) {
        const firstVisible = page.questions.find((question) => !filter.checked || question.response?.correct === false);
        const version = page.focus_version_id ?? firstVisible?.question_version_id;
        if (version) void remember(owner, version);
      }
    }
  }
}

function turnTo(number: number) {
  if (number < 1 || number > page.total_pages) {
    browseStatus.textContent = "请输入 1 到 " + page.total_pages + " 之间的页码。";
    return;
  }
  void navigate(current.action === "browse" ? { action: "browse", page: number, query: current.query }
    : { action: current.action, page: number }, true);
}

previousNext.forEach((button, index) => button.addEventListener("click", () => {
  const number = page.page + (index < previous.length ? -1 : 1);
  turnTo(number);
  if (button.id.includes("bottom")) element("student-page").scrollIntoView({ block: "center" });
}));
jump.addEventListener("submit", (event) => {
  event.preventDefault();
  const number = pageInput.valueAsNumber;
  if (!Number.isInteger(number)) {
    browseStatus.textContent = "请输入有效的页码。";
    return;
  }
  turnTo(number);
});
search.addEventListener("submit", (event) => {
  event.preventDefault();
  const term = query.value.trim();
  if (!term) {
    browseStatus.textContent = "请输入题号、题干或选项文字。";
    return;
  }
  void navigate({ action: "browse", page: 1, query: term });
});
clearSearch.addEventListener("click", () => { void navigate({ action: "browse", page: catalogPage }); });
browseRetry.addEventListener("click", () => { if (failedNavigation) void navigate(failedNavigation); });
catalog.addEventListener("click", () => { void navigate({ action: "browse", page: catalogPage }); });
history.addEventListener("click", () => { void navigate({ action: "answered", page: 1 }); });
mistakes.addEventListener("click", () => { void navigate({ action: "wrong", page: 1 }); });
filter.addEventListener("change", updateSummary);
element("show-privacy").addEventListener("click", () => { element<HTMLDialogElement>("privacy").showModal(); });

drawAuth();
if (client) void restore();
else authStatus.textContent = "此站点尚未配置复习服务。";
