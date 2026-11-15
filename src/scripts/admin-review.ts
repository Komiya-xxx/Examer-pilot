import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from "astro:env/client";
import { formatAnswer, type Answer } from "./answer-format";

type Quality = "low" | "medium" | "high";
type Session = { token: string; expires_at: number };
type Question = {
  question_version_id: string;
  external_id: string;
  version_no: number;
  stem: string;
  options: { id: string; text: string }[];
  standard_answer: Answer | null;
  explanation: string | null;
  quality: Quality | null;
};
type Match = { external_id: string; stem: string; matched_option: string | null };
type Page = { page: number; total_pages: number; total_count: number; questions: Question[]; matches: Match[] };
type Browse = { page: number; query?: string; external_id?: string };
type StaffRequest = { action: "login"; key: string } | ({ action: "browse" } & Browse) |
  { action: "rate"; question_version_id: string; quality: string };

function element<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

class ReviewError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const login = element<HTMLFormElement>("staff-login-form");
const loginPanel = element("staff-login");
const key = element<HTMLInputElement>("staff-key");
const loginButton = login.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const status = element("staff-status");
const review = element("staff-review");
const reviewTitle = element("staff-review-title");
const questions = element("staff-questions");
const pageNumber = element("staff-page");
const browseStatus = element("staff-browse-status");
const searchForm = element<HTMLFormElement>("staff-search-form");
const searchInput = element<HTMLInputElement>("staff-search");
const searchButton = searchForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const clearSearch = element<HTMLButtonElement>("staff-clear-search");
const results = element("staff-search-results");
const resultsTitle = element("staff-results-title");
const matches = element("staff-matches");
const jumpForm = element<HTMLFormElement>("staff-jump-form");
const jumpPage = element<HTMLInputElement>("staff-jump-page");
const jumpButton = jumpForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const template = element<HTMLTemplateElement>("staff-question-template");
const previousButtons = ["staff-prev", "staff-bottom-prev"].map(element<HTMLButtonElement>);
const nextButtons = ["staff-next", "staff-bottom-next"].map(element<HTMLButtonElement>);
const bottomPager = element("staff-bottom-pager");
const exit = element<HTMLButtonElement>("staff-exit");
const qualityLabels: Record<Quality, string> = { low: "低", medium: "中", high: "高" };

let session: Session | null = null;
let expiry: number | undefined;
let currentPage = 1;
let totalPages = 0;
let activeQuery = "";
let returnPage = 1;
let loading = false;
let pendingRatings = 0;

async function request<T>(body: StaffRequest, token?: string): Promise<T> {
  if (!PUBLIC_SUPABASE_URL || !PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new ReviewError("此站点尚未配置审查服务。", 503);
  }
  const headers = new Headers({ "Content-Type": "application/json", apikey: PUBLIC_SUPABASE_PUBLISHABLE_KEY });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(new URL("/functions/v1/admin-review", PUBLIC_SUPABASE_URL), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ReviewError(typeof payload?.message === "string" ? payload.message : "审查服务暂不可用。", response.status);
  }
  return payload as T;
}

function errorText(error: unknown) {
  return error instanceof ReviewError ? error.message : "连接失败，请重试。";
}

function endSession(message: string, focus = true) {
  window.clearTimeout(expiry);
  session = null;
  questions.replaceChildren();
  matches.replaceChildren();
  searchInput.value = "";
  jumpPage.value = "";
  browseStatus.textContent = "";
  currentPage = returnPage = 1;
  totalPages = 0;
  activeQuery = "";
  review.hidden = true;
  loginPanel.hidden = false;
  key.value = "";
  status.textContent = message;
  loading = false;
  pendingRatings = 0;
  if (focus) key.focus();
}

function reportError(error: unknown, target: HTMLElement) {
  if (error instanceof ReviewError && error.status === 401) {
    endSession(error.message);
    return;
  }
  target.textContent = errorText(error);
}

function updateNavigation() {
  const busy = loading || pendingRatings > 0;
  for (const button of previousButtons) button.disabled = busy || currentPage <= 1;
  for (const button of nextButtons) button.disabled = busy || currentPage >= totalPages;
  bottomPager.hidden = totalPages <= 1;
  jumpPage.disabled = jumpButton.disabled = busy || totalPages === 0;
  jumpPage.max = String(totalPages);
  searchInput.readOnly = busy;
  searchButton.disabled = busy;
  clearSearch.hidden = !activeQuery;
  clearSearch.disabled = busy;
  for (const button of matches.querySelectorAll("button")) button.disabled = busy;
}

function renderQuestion(question: Question, authorized: Session) {
  const card = template.content.cloneNode(true) as DocumentFragment;
  const identifier = card.querySelector<HTMLElement>("[data-staff-identifier]")!;
  identifier.id = `staff-question-${question.external_id}`;
  identifier.tabIndex = -1;
  identifier.textContent = `${question.external_id} · 第 ${question.version_no} 版`;
  card.querySelector<HTMLElement>("[data-staff-stem]")!.textContent = question.stem;
  const options = card.querySelector<HTMLElement>("[data-staff-options]")!;
  for (const option of question.options) {
    const row = document.createElement("li");
    row.textContent = `${option.id}．${option.text}`;
    options.append(row);
  }
  options.hidden = question.options.length === 0;
  card.querySelector<HTMLElement>("[data-staff-answer]")!.textContent =
    question.standard_answer === null ? "尚未导入标准答案" : formatAnswer(question.options, question.standard_answer);
  card.querySelector<HTMLElement>("[data-staff-explanation]")!.textContent =
    question.explanation ?? "尚未导入解析";

  const form = card.querySelector<HTMLFormElement>("[data-staff-rating-form]")!;
  const choices = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="quality"]'));
  const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const feedback = form.querySelector<HTMLElement>("[data-staff-rating-status]")!;
  let quality = question.quality;
  for (const choice of choices) choice.checked = choice.value === quality;
  feedback.textContent = quality ? `已保存：${qualityLabels[quality]}` : "尚未评价";
  save.disabled = true;
  form.addEventListener("change", () => {
    save.disabled = choices.find((choice) => choice.checked)?.value === quality;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = choices.find((choice) => choice.checked)?.value;
    if (!selected || selected === quality || save.disabled || session !== authorized || loading) return;
    save.disabled = true;
    for (const choice of choices) choice.disabled = true;
    feedback.textContent = "正在保存…";
    pendingRatings += 1;
    updateNavigation();
    try {
      const saved = await request<{ quality: Quality }>({
        action: "rate", question_version_id: question.question_version_id, quality: selected,
      }, authorized.token);
      if (session !== authorized) return;
      quality = saved.quality;
      feedback.textContent = `已保存：${qualityLabels[quality]}`;
    } catch (error) {
      if (session === authorized) reportError(error, feedback);
    } finally {
      for (const choice of choices) choice.disabled = false;
      save.disabled = selected === quality;
      if (session === authorized) {
        pendingRatings -= 1;
        updateNavigation();
      }
    }
  });
  return card;
}

function renderMatch(match: Match) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "staff-match";
  const id = document.createElement("strong");
  id.textContent = match.external_id;
  const stem = document.createElement("span");
  stem.className = "staff-match-stem";
  stem.textContent = match.stem;
  button.append(id, stem);
  if (match.matched_option !== null) {
    const option = document.createElement("span");
    option.className = "staff-match-option";
    option.textContent = `匹配选项：${match.matched_option}`;
    button.append(option);
  }
  button.addEventListener("click", () => void changePage({ page: 1, external_id: match.external_id }));
  item.append(button);
  return item;
}

function renderPage(page: Page, query: string, authorized: Session) {
  activeQuery = query;
  currentPage = page.page;
  totalPages = page.total_pages;
  if (!query) returnPage = page.page;
  searchInput.value = query;
  jumpPage.value = page.total_pages ? String(page.page) : "";
  jumpPage.removeAttribute("aria-invalid");
  results.hidden = !query;
  questions.hidden = !!query;
  matches.replaceChildren(...page.matches.map(renderMatch));
  questions.replaceChildren(...page.questions.map((question) => renderQuestion(question, authorized)));
  pageNumber.textContent = page.total_pages ? `第 ${page.page} / ${page.total_pages} 页 · 共 ${page.total_count} 题` : "";
  browseStatus.textContent = page.total_count === 0 ? (query ? "没有找到匹配的题目。" : "暂无可审查的题目。") : "";
  updateNavigation();
}

async function changePage(target: Browse) {
  const authorized = session;
  if (!authorized || loading || pendingRatings > 0) return;
  loading = true;
  browseStatus.textContent = target.query ? "正在搜索…" : "正在加载题目…";
  updateNavigation();
  try {
    const page = await request<Page>({ action: "browse", ...target }, authorized.token);
    if (session !== authorized) return;
    renderPage(page, target.query ?? "", authorized);
    const located = target.external_id && document.getElementById(`staff-question-${target.external_id}`);
    if (located) {
      located.closest(".staff-card")?.classList.add("staff-card-located");
      located.focus({ preventScroll: true });
      located.scrollIntoView({ block: "start" });
    } else {
      (target.query ? resultsTitle : reviewTitle).focus();
    }
  } catch (error) {
    if (session === authorized) reportError(error, browseStatus);
  } finally {
    if (session === authorized) {
      loading = false;
      updateNavigation();
    }
  }
}

login.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginButton.disabled) return;
  loginButton.disabled = true;
  const submittedKey = key.value.trim();
  key.value = "";
  status.textContent = "正在验证…";
  try {
    const authorized = await request<Session>({ action: "login", key: submittedKey });
    const page = await request<Page>({ action: "browse", page: 1 }, authorized.token);
    renderPage(page, "", authorized);
    session = authorized;
    status.textContent = "";
    loginPanel.hidden = true;
    review.hidden = false;
    reviewTitle.focus();
    expiry = window.setTimeout(() => endSession("审查会话已过期，请重新输入密钥。"),
      Math.max(0, authorized.expires_at * 1000 - Date.now()));
  } catch (error) {
    status.textContent = errorText(error);
    key.focus();
  } finally {
    loginButton.disabled = false;
  }
});

for (const button of previousButtons) {
  button.addEventListener("click", () => {
    if (currentPage > 1) void changePage({ page: currentPage - 1, query: activeQuery || undefined });
  });
}
for (const button of nextButtons) {
  button.addEventListener("click", () => {
    if (currentPage < totalPages) void changePage({ page: currentPage + 1, query: activeQuery || undefined });
  });
}
jumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (jumpButton.disabled) return;
  const page = jumpPage.valueAsNumber;
  if (!Number.isInteger(page) || page < 1 || page > totalPages) {
    browseStatus.textContent = `请输入 1 至 ${totalPages} 之间的整数页码。`;
    jumpPage.setAttribute("aria-invalid", "true");
    jumpPage.focus();
    return;
  }
  void changePage({ page, query: activeQuery || undefined });
});
jumpPage.addEventListener("input", () => jumpPage.removeAttribute("aria-invalid"));
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (query) void changePage({ page: 1, query });
  else if (activeQuery) void changePage({ page: returnPage });
  else searchInput.focus();
});
clearSearch.addEventListener("click", () => {
  void changePage({ page: returnPage });
});
exit.addEventListener("click", () => endSession("已退出审查。"));
window.addEventListener("pagehide", () => endSession("", false));
loginButton.disabled = false;
