import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from "astro:env/client";
import { formatAnswer, type Answer } from "./answer-format";

type Quality = "low" | "medium" | "high";
type Cursor = string | null;
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
type Page = { questions: Question[]; next_cursor: Cursor };
type StaffRequest = { action: "login"; key: string } | { action: "list"; after: Cursor } |
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
const template = element<HTMLTemplateElement>("staff-question-template");
const prev = element<HTMLButtonElement>("staff-prev");
const next = element<HTMLButtonElement>("staff-next");
const exit = element<HTMLButtonElement>("staff-exit");
const qualityLabels: Record<Quality, string> = { low: "低", medium: "中", high: "高" };

let session: Session | null = null;
let expiry: number | undefined;
let cursors: Cursor[] = [null];
let currentPage = 0;
let nextCursor: Cursor = null;
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
  prev.disabled = loading || pendingRatings > 0 || currentPage === 0;
  next.disabled = loading || pendingRatings > 0 || nextCursor === null;
}

function renderQuestion(question: Question, authorized: Session) {
  const card = template.content.cloneNode(true) as DocumentFragment;
  const identifier = card.querySelector<HTMLElement>("[data-staff-identifier]")!;
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

function renderPage(page: Page, index: number, authorized: Session) {
  questions.replaceChildren(...page.questions.map((question) => renderQuestion(question, authorized)));
  currentPage = index;
  nextCursor = page.next_cursor;
  pageNumber.textContent = page.questions.length ? `第 ${index + 1} 页` : "";
  status.textContent = page.questions.length ? "" : "暂无可审查的题目。";
  updateNavigation();
}

async function changePage(index: number, cursor: Cursor) {
  const authorized = session;
  if (!authorized || loading || pendingRatings > 0) return;
  loading = true;
  status.textContent = "正在加载题目…";
  updateNavigation();
  try {
    const page = await request<Page>({ action: "list", after: cursor }, authorized.token);
    if (session !== authorized) return;
    cursors[index] = cursor;
    renderPage(page, index, authorized);
    reviewTitle.focus();
  } catch (error) {
    if (session === authorized) reportError(error, status);
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
    const page = await request<Page>({ action: "list", after: null }, authorized.token);
    renderPage(page, 0, authorized);
    session = authorized;
    cursors = [null];
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

prev.addEventListener("click", () => {
  if (currentPage > 0) void changePage(currentPage - 1, cursors[currentPage - 1]);
});
next.addEventListener("click", () => {
  if (nextCursor !== null) void changePage(currentPage + 1, nextCursor);
});
exit.addEventListener("click", () => endSession("已退出审查。"));
window.addEventListener("pagehide", () => endSession("", false));
loginButton.disabled = false;
