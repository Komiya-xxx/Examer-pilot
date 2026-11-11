import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from "astro:env/client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Quality = "low" | "medium" | "high";
type Answer = string | string[] | boolean;
type QuestionType = "single_choice" | "multiple_choice" | "true_false";
type Operation = "get-active-round" | "start-or-resume-session" | "get-review-session" |
  "submit-review-answer" | "submit-review-rating";

interface ResponseView {
  id: string;
  selected_answer: Answer;
  rating: { quality: Quality; source: "default" | "explicit" | "legacy" } | null;
  feedback: { correct: boolean; standard_answer: Answer; explanation: string } | null;
}

interface Question {
  assignment_id: string;
  position: number;
  question_type: QuestionType;
  stem: string;
  options: { id: string; text: string }[];
  response: ResponseView | null;
}

interface ReviewSession {
  session_id: string;
  status: "in_progress" | "completed";
  questions: Question[];
}

const typeLabels: Record<QuestionType, string> = {
  single_choice: "单选题", multiple_choice: "多选题", true_false: "判断题",
};
const judgmentOptions = [{ id: "true", text: "正确" }, { id: "false", text: "错误" }];
const qualityLabels = { low: "低", medium: "中", high: "高" };
const qualityHints = {
  low: "谢谢你的反馈！这道题今后可能更少发放。",
  medium: "保存后会记录为你主动给出的「中」。",
  high: "谢谢你的反馈！这道题今后更有机会发放。",
};

function element<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

const privacy = element<HTMLDialogElement>("privacy");
const statusCard = element("status-card");
const lobbyStatus = element("lobby-status");
const retry = element<HTMLButtonElement>("enter-lobby");
const typeStatus = element("type-status");
const sessionSection = element("saved-session");
const sessionProgress = element("session-progress");
const questionMap = element("question-map");
const questionSection = element("current-question");
const questionProgress = element("question-progress");
const questionType = element("question-type");
const questionStem = element("question-stem");
const form = element<HTMLFormElement>("answer-form");
const answerOptions = element<HTMLFieldSetElement>("answer-options");
const questionOptions = element("question-options");
const reviewOptions = element("review-options");
const review = element("answer-review");
const verdict = element("answer-verdict");
const standardAnswer = element("standard-answer");
const explanation = element("answer-explanation");
const savedAnswer = element("saved-answer");
const ratingOptions = element<HTMLFieldSetElement>("rating-options");
const qualityFeedback = element("quality-feedback");
const questionStatus = element("question-status");
const submitButton = element<HTMLButtonElement>("submit-answer");
const saveRating = element<HTMLButtonElement>("save-rating");

function showNotice() {
  const key = "examerframe-notice-dismissed-v1";
  try {
    if (localStorage.getItem(key) === "1") return;
  } catch { /* Browser blocked persistent storage. */ }
  privacy.addEventListener("close", () => {
    try { localStorage.setItem(key, "1"); } catch { /* Dismissed for this visit. */ }
  }, { once: true });
  privacy.showModal();
}

function showStatus(message: string, retryLabel?: string) {
  lobbyStatus.textContent = message;
  retry.hidden = !retryLabel;
  if (retryLabel) retry.textContent = retryLabel;
  statusCard.hidden = !message && !retryLabel;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-practice-type]")) {
  button.addEventListener("click", () => {
    const label = button.textContent?.trim() ?? "";
    typeStatus.textContent = button.dataset.practiceType === "choice"
      ? "当前提供选择题。可点题号自由复习。"
      : button.dataset.practiceType === "updates"
        ? "更多题型正在准备，欢迎先试试选择题。"
        : label + "正在准备，开放后可在这里切换。";
  });
}

function formatAnswer(question: Question, answer: Answer) {
  if (typeof answer === "boolean") return answer ? "正确" : "错误";
  return (Array.isArray(answer) ? answer : [answer]).map((id) => {
    const option = question.options.find((item) => item.id === id);
    return option ? id + "．" + option.text : id;
  }).join("；");
}

function renderChoices(question: Question, draft: Answer | undefined) {
  const judgment = question.question_type === "true_false";
  const options = judgment ? judgmentOptions : question.options;
  const value = question.response?.selected_answer ?? draft;
  const selected = new Set(Array.isArray(value) ? value : value === undefined ? [] : [String(value)]);
  const items = options.map((option) => {
    const row = document.createElement(question.response ? "div" : "label");
    row.className = "choice-row";
    if (!question.response) {
      const input = document.createElement("input");
      input.type = question.question_type === "multiple_choice" ? "checkbox" : "radio";
      input.name = "answer";
      input.value = option.id;
      input.checked = selected.has(option.id);
      row.append(input);
    }
    if (!judgment) {
      const code = document.createElement("span");
      code.className = "option-code";
      code.textContent = option.id;
      row.append(code);
    }
    const text = document.createElement("span");
    text.className = "option-text";
    text.textContent = option.text;
    row.append(text);
    const item = document.createElement("li");
    item.append(row);
    return item;
  });
  questionOptions.replaceChildren(...(question.response ? [] : items));
  reviewOptions.replaceChildren(...(question.response ? items : []));
  answerOptions.hidden = Boolean(question.response);
  reviewOptions.hidden = !question.response;
  answerOptions.removeAttribute("aria-invalid");
  answerOptions.querySelector("legend")!.textContent =
    question.question_type === "multiple_choice" ? "选择一项或多项答案" : "选择一项答案";
}

function chosenAnswer(type: QuestionType): Answer | undefined {
  const ids = [...answerOptions.querySelectorAll<HTMLInputElement>('input[name="answer"]:checked')]
    .map((input) => input.value);
  if (!ids.length) return undefined;
  if (type === "multiple_choice") return ids;
  return type === "true_false" ? ids[0] === "true" : ids[0];
}

function chosenQuality(): Quality | undefined {
  const value = ratingOptions.querySelector<HTMLInputElement>('input[name="quality"]:checked')?.value;
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function ratingIsSaved(response: ResponseView) {
  return !!response.rating && response.rating.source !== "default";
}

function renderReview(question: Question, animate: boolean) {
  const response = question.response;
  const feedback = response?.feedback;
  review.hidden = !response;
  review.classList.remove("play-feedback");
  review.dataset.result = feedback ? (feedback.correct ? "correct" : "incorrect") : "unavailable";
  verdict.textContent = !response ? "" : !feedback ? "答案已保存，解析暂未提供"
    : feedback.correct ? "✓ 答对啦！" : "这题答错了，看看解析吧。";
  standardAnswer.textContent = feedback ? formatAnswer(question, feedback.standard_answer) : "暂未提供";
  explanation.textContent = feedback?.explanation ?? "这道题的解析暂未提供。";
  savedAnswer.textContent = response ? formatAnswer(question, response.selected_answer) : "";
  if (animate && feedback) review.classList.add("play-feedback");
}

class RequestError extends Error {}

async function getAnonymousSession(client: SupabaseClient, maySignIn: boolean) {
  async function restoreOrSignIn() {
    const existing = await client.auth.getSession();
    if (existing.error) throw existing.error;
    if (existing.data.session?.user.is_anonymous) return existing.data.session;
    if (!maySignIn) return null;
    const created = await client.auth.signInAnonymously();
    if (created.error) throw created.error;
    return created.data.session;
  }

  return maySignIn && navigator.locks
    ? navigator.locks.request("examerframe-anonymous-sign-in", restoreOrSignIn)
    : restoreOrSignIn();
}

function connect(url: string, publishableKey: string) {
  const host = new URL(url).host;
  const client = createClient(url, publishableKey, {
    auth: { detectSessionInUrl: false, storageKey: "examerframe-auth-" + host },
  });
  const answerDrafts = new Map<string, Answer>();
  const ratingDrafts = new Map<string, Quality>();
  let session: ReviewSession | undefined;
  let position: number | undefined;
  let busy = false;

  const current = () => session?.questions.find((question) => question.position === position);

  async function request<T>(name: Operation, token: string, body?: object): Promise<T> {
    const headers = new Headers({ apikey: publishableKey, Authorization: "Bearer " + token });
    if (body) headers.set("Content-Type", "application/json");
    const response = await fetch(url.replace(/\/$/, "") + "/functions/v1/" + name, {
      method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined,
      credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new RequestError(typeof payload?.message === "string" ? payload.message : "暂时无法连接，请重试。");
    }
    return response.json();
  }

  function renderRatingHint() {
    const response = current()?.response;
    if (!response) return;
    const quality = chosenQuality();
    qualityFeedback.textContent = response.rating && ratingIsSaved(response)
      ? "已记录：「" + qualityLabels[response.rating.quality] + "」。"
      : quality ? qualityHints[quality]
      : response.rating ? "不主动选择时，本题按「中」记录。" : "这道题此前未保存评价。现在也可以补评。";
    saveRating.disabled = busy || !quality || ratingIsSaved(response);
  }

  function setBusy(value: boolean) {
    busy = value;
    const question = current();
    retry.disabled = value;
    submitButton.disabled = value || !question || !!question.response;
    answerOptions.disabled = value || !question || !!question.response;
    ratingOptions.disabled = value || !question?.response || ratingIsSaved(question.response);
    questionMap.querySelectorAll("button").forEach((button) => { button.disabled = value; });
    questionSection.setAttribute("aria-busy", String(value));
    renderRatingHint();
  }

  function render({ animate = false, focus = false } = {}) {
    const question = current();
    const questions = session?.questions ?? [];
    sessionSection.hidden = questions.length === 0;
    questionSection.hidden = !question;
    questionStatus.textContent = "";
    const answered = questions.filter((item) => item.response).length;
    sessionProgress.textContent = answered === questions.length
      ? "全部作答完成 · 可回看解析"
      : "已作答 " + answered + " / " + questions.length + " 题 · 点击题号跳转";
    questionMap.replaceChildren(...questions.map((item) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      li.dataset.state = item.position === position ? "current" : item.response ? "done" : "upcoming";
      button.type = "button";
      button.dataset.position = String(item.position);
      button.textContent = String(item.position).padStart(2, "0");
      button.setAttribute("aria-label", "第 " + item.position + " 题，" + (item.response ? "已作答" : "未作答"));
      if (item.position === position) button.setAttribute("aria-current", "step");
      li.append(button);
      return li;
    }));
    if (question) {
      questionProgress.textContent = "第 " + question.position + " 题";
      questionType.textContent = typeLabels[question.question_type];
      questionStem.textContent = question.stem;
      renderChoices(question, answerDrafts.get(question.assignment_id));
      renderReview(question, animate);
      submitButton.hidden = !!question.response;
      ratingOptions.hidden = !question.response;
      const rating = question.response?.rating;
      const selected = rating && rating.source !== "default" ? rating.quality : ratingDrafts.get(question.assignment_id);
      for (const input of ratingOptions.querySelectorAll<HTMLInputElement>('input[name="quality"]')) {
        input.checked = input.value === selected;
      }
    }
    setBusy(busy);
    if (question && focus && !privacy.open) (animate && question.response ? verdict : questionProgress).focus();
  }

  function readSession(sessionId: string, token: string) {
    return request<ReviewSession>("get-review-session", token, { session_id: sessionId });
  }

  function positionKey(sessionId: string) {
    return "examerframe-review-position:" + host + ":" + sessionId;
  }

  async function refresh() {
    if (busy) return;
    setBusy(true);
    showStatus("正在准备复习题单…");
    try {
      const identity = await getAnonymousSession(client, true);
      if (!identity) throw new RequestError("暂时无法建立匿名会话。");
      const token = identity.access_token;
      const lobby = await request<{ round: { id: string } | null; session: { id: string } | null }>("get-active-round", token);
      let id = lobby.session?.id;
      if (!id && lobby.round) {
        const started = await request<{ session: { id: string } | null }>(
          "start-or-resume-session", token, { round_id: lobby.round.id },
        );
        id = started.session?.id;
      }
      if (!id) {
        showStatus("当前没有开放的题单，请稍后再查看。", "刷新状态");
        return;
      }
      session = await readSession(id, token);
      if (!session.questions.length) throw new RequestError("暂时无法加载题单。");
      let previous: number | undefined;
      try { previous = Number(sessionStorage.getItem(positionKey(id))); } catch { /* Use the first unanswered question. */ }
      position = session.questions.find((item) => item.position === previous)?.position
        ?? session.questions.find((item) => !item.response)?.position ?? session.questions[0].position;
      showStatus("");
      render();
    } catch (error) {
      const disabled = error && typeof error === "object" && "code" in error && error.code === "anonymous_provider_disabled";
      showStatus(disabled ? "当前暂未开放匿名参与，请稍后再试。"
        : error instanceof RequestError ? error.message : "暂时无法连接，请重试。", "重试");
    } finally {
      setBusy(false);
    }
  }

  async function save(kind: "answer" | "rating") {
    const question = current();
    if (busy || !session || !question) return;
    const id = session.session_id;
    const response = question.response;
    let body: object;
    if (kind === "answer") {
      if (response) return;
      const answer = chosenAnswer(question.question_type);
      if (answer === undefined) {
        answerOptions.setAttribute("aria-invalid", "true");
        questionStatus.textContent = "请先选择答案；也可以直接点题号跳过。";
        answerOptions.querySelector("input")?.focus();
        return;
      }
      body = { session_id: id, assignment_id: question.assignment_id, answer };
    } else {
      const quality = chosenQuality();
      if (!response || ratingIsSaved(response) || !quality) return;
      body = { response_id: response.id, quality };
    }

    setBusy(true);
    questionStatus.textContent = kind === "answer" ? "正在保存答案…" : "正在保存评价…";
    let token: string | undefined;
    try {
      const identity = await getAnonymousSession(client, false);
      if (!identity) throw new RequestError("会话已失效，请刷新页面后继续。");
      token = identity.access_token;
      session = await request<ReviewSession>(
        kind === "answer" ? "submit-review-answer" : "submit-review-rating", token, body,
      );
      if (kind === "answer") answerDrafts.delete(question.assignment_id);
      else ratingDrafts.delete(question.assignment_id);
      render({ animate: kind === "answer", focus: kind === "answer" });
    } catch (error) {
      // The response may have been lost after committing. Reconcile on the
      // owned session; an unchanged question keeps its unsaved choices.
      if (token) {
        try {
          const latest = await readSession(id, token);
          const restored = latest.questions.find((item) => item.assignment_id === question.assignment_id)?.response;
          if (restored && (kind === "answer" || ratingIsSaved(restored))) {
            session = latest;
            answerDrafts.delete(question.assignment_id);
            ratingDrafts.delete(question.assignment_id);
            render({ animate: kind === "answer", focus: kind === "answer" });
            questionStatus.textContent = "已恢复服务端保存的记录。";
            return;
          }
        } catch { /* Preserve this question and allow retry. */ }
      }
      questionStatus.textContent = (kind === "answer" ? "答案" : "评价") + "尚未确认，请重试。"
        + (error instanceof RequestError ? error.message : "");
    } finally {
      setBusy(false);
    }
  }

  questionMap.addEventListener("click", (event) => {
    if (busy || !session || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-position]");
    const next = Number(button?.dataset.position);
    if (!session.questions.some((item) => item.position === next)) return;
    position = next;
    try { sessionStorage.setItem(positionKey(session.session_id), String(next)); } catch { /* Still navigate. */ }
    render({ focus: true });
  });

  answerOptions.addEventListener("change", () => {
    const question = current();
    if (question) {
      const draft = chosenAnswer(question.question_type);
      if (draft === undefined) answerDrafts.delete(question.assignment_id);
      else answerDrafts.set(question.assignment_id, draft);
    }
    answerOptions.removeAttribute("aria-invalid");
    questionStatus.textContent = "";
  });

  ratingOptions.addEventListener("change", () => {
    const question = current();
    const quality = chosenQuality();
    if (question && quality) ratingDrafts.set(question.assignment_id, quality);
    renderRatingHint();
  });
  form.addEventListener("submit", (event) => { event.preventDefault(); void save("answer"); });
  saveRating.addEventListener("click", () => void save("rating"));
  retry.addEventListener("click", () => void refresh());
  void refresh();
}

showNotice();
if (PUBLIC_SUPABASE_URL && PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  connect(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY);
} else {
  showStatus("本环境暂未连接答题服务。");
}
