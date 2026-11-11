import { PUBLIC_SUPABASE_PUBLISHABLE_KEY, PUBLIC_SUPABASE_URL } from "astro:env/client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface RoundPreview {
  id: string;
  title: string;
  description: string;
  questions_per_session: number;
}

interface SessionSummary {
  id: string;
  round_id: string;
  status: "in_progress" | "completed";
  assigned_count: number;
  rated_count: number;
}

interface Lobby {
  round: RoundPreview | null;
  session: SessionSummary | null;
}

type Quality = "low" | "medium" | "high";

interface QuestionView {
  assignment_id: string;
  position: number;
  question_type: "single_choice" | "multiple_choice" | "true_false";
  stem: string;
  options: { id: string; text: string }[];
}

interface CurrentQuestion {
  session: SessionSummary;
  step: "answer" | "rating" | "completed";
  question: QuestionView | null;
  response_id: string | null;
}

type OpenQuestion = { session: SessionSummary; question: QuestionView } & (
  | { step: "answer"; response_id: null }
  | { step: "rating"; response_id: string }
);

type EdgeOperation = "get-active-round" | "start-or-resume-session" |
  "get-current-question" | "submit-answer" | "submit-rating";

const TYPE_LABELS: Record<QuestionView["question_type"], string> = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  true_false: "判断题",
};

const TRUE_FALSE_OPTIONS = [
  { id: "true", text: "正确" },
  { id: "false", text: "错误" },
];

const QUALITY_HINTS: Record<Quality, string> = {
  low: "谢谢你的反馈！这道题今后可能更少发放。",
  medium: "这道题将以「中」计入评价。",
  high: "谢谢你的反馈！这道题今后更有机会发放。",
};

const ERROR_MESSAGES: Record<string, string> = {
  ROUND_NOT_OPEN: "当前没有可参与的批次，请稍后再试。",
  QUESTION_POOL_TOO_SMALL: "当前批次的题目不足，请稍后再试。",
  SESSION_NOT_FOUND: "没有找到你的答题会话，请重试。",
};

const privacy = document.querySelector<HTMLDialogElement>("#privacy")!;
const statusCard = document.querySelector<HTMLElement>("#status-card")!;
const lobbyStatus = document.querySelector<HTMLElement>("#lobby-status")!;
const retry = document.querySelector<HTMLButtonElement>("#enter-lobby")!;
const roundSection = document.querySelector<HTMLElement>("#active-round")!;
const roundTitle = document.querySelector<HTMLElement>("#round-title")!;
const roundDescription = document.querySelector<HTMLElement>("#round-description")!;
const roundSize = document.querySelector<HTMLElement>("#round-size")!;
const sessionSection = document.querySelector<HTMLElement>("#saved-session")!;
const sessionProgress = document.querySelector<HTMLElement>("#session-progress")!;
const questionMap = document.querySelector<HTMLOListElement>("#question-map")!;
const questionSection = document.querySelector<HTMLElement>("#current-question")!;
const questionProgress = document.querySelector<HTMLElement>("#question-progress")!;
const questionType = document.querySelector<HTMLElement>("#question-type")!;
const questionStem = document.querySelector<HTMLElement>("#question-stem")!;
const form = document.querySelector<HTMLFormElement>("#answer-form")!;
const answerOptions = document.querySelector<HTMLFieldSetElement>("#answer-options")!;
const questionOptions = document.querySelector<HTMLOListElement>("#question-options")!;
const reviewOptions = document.querySelector<HTMLOListElement>("#review-options")!;
const ratingOptions = document.querySelector<HTMLFieldSetElement>("#rating-options")!;
const qualityFeedback = document.querySelector<HTMLElement>("#quality-feedback")!;
const questionStatus = document.querySelector<HTMLElement>("#question-status")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit-answer")!;

let current: OpenQuestion | null = null;
let busy = false;

function showNotice() {
  const key = "examerframe-notice-dismissed-v1";
  try {
    if (localStorage.getItem(key) === "1") return;
  } catch {
    // The notice still works when the browser blocks persistent storage.
  }
  privacy.addEventListener("close", () => {
    try { localStorage.setItem(key, "1"); } catch { /* Dismissed for this visit. */ }
  }, { once: true });
  privacy.showModal();
}

function showLobbyStatus(message: string, retryLabel?: string) {
  lobbyStatus.textContent = message;
  retry.hidden = !retryLabel;
  if (retryLabel) retry.textContent = retryLabel;
  statusCard.hidden = !message && !retryLabel;
}

function setBusy(value: boolean) {
  busy = value;
  retry.disabled = value;
  submitButton.disabled = value || !current;
  answerOptions.disabled = value || current?.step !== "answer";
  ratingOptions.disabled = value || !current;
  questionSection.setAttribute("aria-busy", String(value));
}

function renderRound(round: RoundPreview | null) {
  roundSection.hidden = !round;
  if (!round) return;
  roundTitle.textContent = round.title;
  roundDescription.textContent = round.description;
  roundDescription.hidden = !round.description;
  roundSize.textContent = `每次发放 ${round.questions_per_session} 道题`;
}

function renderSession(session: SessionSummary | null, currentPosition?: number) {
  sessionSection.hidden = !session;
  if (!session) return;

  sessionProgress.textContent = `已完成 ${session.rated_count} / ${session.assigned_count} 题`;
  const items = Array.from({ length: session.assigned_count }, (_, index) => {
    const number = index + 1;
    const item = document.createElement("li");
    const state = number <= session.rated_count ? "done" : number === currentPosition ? "current" : "upcoming";
    item.dataset.state = state;
    item.textContent = String(number).padStart(2, "0");
    item.setAttribute("aria-label", `第 ${number} 题：${state === "done" ? "已完成" : state === "current" ? "当前题目" : "未完成"}`);
    if (state === "current") item.setAttribute("aria-current", "step");
    return item;
  });
  questionMap.replaceChildren(...items);
}

function hideQuestion() {
  current = null;
  questionSection.hidden = true;
  questionOptions.replaceChildren();
  reviewOptions.replaceChildren();
  questionStatus.textContent = "";
  setBusy(busy);
}

function isQuality(value: unknown): value is Quality {
  return value === "low" || value === "medium" || value === "high";
}

function selectedQuality(): Quality | null {
  const value = ratingOptions.querySelector<HTMLInputElement>('input[name="quality"]:checked')?.value;
  return isQuality(value) ? value : null;
}

function renderQualityFeedback() {
  const quality = selectedQuality();
  qualityFeedback.textContent = quality ? QUALITY_HINTS[quality] : "不选时按「中」记录。";
}

function renderChoices(question: QuestionView, readOnly: boolean) {
  const type = question.question_type;
  const options = type === "true_false" ? TRUE_FALSE_OPTIONS : question.options;
  const items = options.map((option) => {
    const row = document.createElement(readOnly ? "div" : "label");
    row.className = "choice-row";
    if (!readOnly) {
      const input = document.createElement("input");
      input.type = type === "multiple_choice" ? "checkbox" : "radio";
      input.name = "answer";
      input.value = option.id;
      row.append(input);
    }
    if (type !== "true_false") {
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
  questionOptions.replaceChildren(...(readOnly ? [] : items));
  reviewOptions.replaceChildren(...(readOnly ? items : []));
  answerOptions.hidden = readOnly;
  reviewOptions.hidden = !readOnly;
  answerOptions.removeAttribute("aria-invalid");
  const legend = answerOptions.querySelector("legend")!;
  legend.textContent = type === "multiple_choice" ? "选择一项或多项答案" : "选择一项答案";
}

function selectedAnswer(type: QuestionView["question_type"]) {
  const ids = [...answerOptions.querySelectorAll<HTMLInputElement>('input[name="answer"]:checked')]
    .map((input) => input.value);
  if (!ids.length) return null;
  if (type === "multiple_choice") return ids;
  if (type === "true_false") return ids[0] === "true";
  return ids[0];
}

class LobbyRequestError extends Error {}

interface RatingIntent {
  assignmentId: string;
  quality: Quality | null;
}

// Keep the selected rating through a reload between the two existing writes.
// Limit it to this tab, this project and this session; never store the answer here.
function ratingIntentStore(project: string) {
  const key = (sessionId: string) => `examerframe-rating-intent:${project}:${sessionId}`;
  const memory = new Map<string, RatingIntent>();
  return {
    read(sessionId: string): RatingIntent | null {
      const remembered = memory.get(sessionId);
      if (remembered) return remembered;
      try {
        const raw = sessionStorage.getItem(key(sessionId));
        if (!raw) return null;
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === "object" && "assignmentId" in value &&
          typeof value.assignmentId === "string" && "quality" in value &&
          (value.quality === null || isQuality(value.quality))) {
          return { assignmentId: value.assignmentId, quality: value.quality };
        }
      } catch { /* Storage is only used to restore an unfinished rating. */ }
      return null;
    },
    save(sessionId: string, intent: RatingIntent) {
      memory.set(sessionId, intent);
      try { sessionStorage.setItem(key(sessionId), JSON.stringify(intent)); } catch { /* Keep it in memory. */ }
    },
    clear(sessionId: string) {
      memory.delete(sessionId);
      try { sessionStorage.removeItem(key(sessionId)); } catch { /* Nothing else to clear. */ }
    },
  };
}

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

  // Serialize initial visits in two tabs so they can reuse one identity.
  return maySignIn && navigator.locks
    ? navigator.locks.request("examerframe-anonymous-sign-in", restoreOrSignIn)
    : restoreOrSignIn();
}

function connect(url: string, publishableKey: string) {
  const host = new URL(url).host;
  const intents = ratingIntentStore(host);
  const client = createClient(url, publishableKey, {
    auth: { detectSessionInUrl: false, storageKey: `examerframe-auth-${host}` },
  });

  async function read<T>(name: EdgeOperation, token: string, body?: Record<string, unknown>): Promise<T> {
    const headers = new Headers({ apikey: publishableKey, Authorization: `Bearer ${token}` });
    if (body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${url.replace(/\/$/, "")}/functions/v1/${name}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null);
      const payload = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
      const known = typeof payload.code === "string" ? ERROR_MESSAGES[payload.code] : undefined;
      throw new LobbyRequestError(known ?? (typeof payload.message === "string" && payload.message
        ? payload.message
        : "暂时无法读取会话，请重试。"));
    }
    return response.json();
  }

  function renderQuestion({ session, step, question, response_id }: CurrentQuestion) {
    const intent = intents.read(session.id);
    if (intent && (step === "completed" || intent.assignmentId !== question?.assignment_id)) {
      intents.clear(session.id);
    }
    renderSession(session, question?.position);

    if (step === "completed" || session.status === "completed") {
      hideQuestion();
      showLobbyStatus("这组题已完成。谢谢你的作答和反馈！");
      return;
    }

    if (!question || !Object.hasOwn(TYPE_LABELS, question.question_type) || (step === "rating" && !response_id)) {
      hideQuestion();
      showLobbyStatus("暂时无法加载当前题目，请重试。", "重试");
      return;
    }

    current = step === "rating"
      ? { session, question, step, response_id: response_id! }
      : { session, question, step: "answer", response_id: null };
    questionProgress.textContent = `第 ${question.position} 题`;
    questionType.textContent = TYPE_LABELS[question.question_type];
    questionStem.textContent = question.stem;
    renderChoices(question, step === "rating");

    const remembered = intent?.assignmentId === question.assignment_id ? intent.quality : null;
    for (const input of ratingOptions.querySelectorAll<HTMLInputElement>('input[name="quality"]')) {
      input.checked = input.value === remembered;
    }
    renderQualityFeedback();
    submitButton.textContent = step === "rating" ? "继续下一题" : "提交并继续";
    questionStatus.textContent = step === "rating" ? "答案已保存，可继续。评价不选时按「中」记录。" : "";
    questionSection.hidden = false;
    showLobbyStatus("");
    setBusy(busy);
  }

  function fetchQuestion(sessionId: string, token: string) {
    return read<CurrentQuestion>("get-current-question", token, { session_id: sessionId });
  }

  async function refresh() {
    if (busy) return;
    setBusy(true);
    showLobbyStatus("正在准备答题界面…");

    try {
      const identity = await getAnonymousSession(client, true);
      if (!identity) throw new LobbyRequestError("暂时无法建立匿名会话，请重试。");
      const token = identity.access_token;
      const lobby = await read<Lobby>("get-active-round", token);
      renderRound(lobby.session && lobby.session.round_id !== lobby.round?.id ? null : lobby.round);

      // Restore a saved session first, including one from a closed batch.
      if (lobby.session) {
        renderQuestion(await fetchQuestion(lobby.session.id, token));
        return;
      }

      if (!lobby.round) {
        hideQuestion();
        renderSession(null);
        showLobbyStatus("当前没有开放的批次，请稍后再查看。", "刷新状态");
        return;
      }

      const started = await read<{ session: SessionSummary | null }>(
        "start-or-resume-session", token, { round_id: lobby.round.id },
      );
      if (!started.session) throw new LobbyRequestError("暂时无法创建答题会话，请重试。");
      renderQuestion(await fetchQuestion(started.session.id, token));
    } catch (error) {
      hideQuestion();
      const disabled = error && typeof error === "object" && "code" in error &&
        error.code === "anonymous_provider_disabled";
      showLobbyStatus(disabled ? "当前暂未开放匿名参与，请稍后再试。"
        : error instanceof LobbyRequestError ? error.message : "暂时无法连接，请重试。", "重试");
    } finally {
      setBusy(false);
    }
  }

  function focusNextQuestion() {
    if (!questionSection.hidden && !privacy.open) questionProgress.focus();
  }

  async function submit() {
    const view = current;
    if (busy || !view) return;

    const { session, question } = view;
    const answer = view.step === "answer" ? selectedAnswer(question.question_type) : null;
    if (view.step === "answer" && answer === null) {
      answerOptions.setAttribute("aria-invalid", "true");
      questionStatus.textContent = question.question_type === "multiple_choice"
        ? "请至少选择一项答案。" : "请先选择一项答案。";
      answerOptions.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }

    const selection = selectedQuality();
    const quality = selection ?? "medium";
    intents.save(session.id, { assignmentId: question.assignment_id, quality: selection });
    setBusy(true);
    let token: string | undefined;
    let ratingSaved = false;

    try {
      const identity = await getAnonymousSession(client, false);
      if (!identity) {
        hideQuestion();
        showLobbyStatus("会话已失效，请刷新后继续。", "刷新状态");
        return;
      }
      token = identity.access_token;

      let responseId = view.response_id;
      if (view.step === "answer") {
        questionStatus.textContent = "正在保存答案…";
        const result = await read<{ response_id: string }>("submit-answer", token, {
          session_id: session.id, assignment_id: question.assignment_id, answer,
        });
        responseId = result.response_id;
        renderQuestion({ session, question, step: "rating", response_id: responseId });
      }

      questionStatus.textContent = "正在保存评价…";
      await read("submit-rating", token, { response_id: responseId, quality });
      ratingSaved = true;
      intents.clear(session.id);
      renderQuestion(await fetchQuestion(session.id, token));
      focusNextQuestion();
    } catch (error) {
      if (ratingSaved) {
        hideQuestion();
        showLobbyStatus("答案和评价已保存，请刷新以继续。", "刷新状态");
        return;
      }

      // The request may have reached the server even when the response was
      // lost. Prefer server progress; keep controls intact on the same step.
      if (token) {
        try {
          const next = await fetchQuestion(session.id, token);
          const advanced = next.step === "completed" || next.question?.assignment_id !== question.assignment_id;
          if (advanced || next.step !== current?.step || next.response_id !== current?.response_id) {
            renderQuestion(next);
          }
          if (advanced) {
            focusNextQuestion();
            return;
          }
        } catch { /* Keep the visible state and allow an idempotent retry. */ }
      }

      const hint = error instanceof LobbyRequestError ? error.message : "";
      questionStatus.textContent = current?.step === "rating"
        ? `答案已保存，评价尚未确认，请重试。${hint}`
        : `答案尚未确认，请重试。${hint}`;
    } finally {
      setBusy(false);
    }
  }

  retry.addEventListener("click", () => void refresh());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  void refresh();
}

ratingOptions.addEventListener("change", renderQualityFeedback);
answerOptions.addEventListener("change", () => {
  answerOptions.removeAttribute("aria-invalid");
  questionStatus.textContent = "";
});

showNotice();
if (PUBLIC_SUPABASE_URL && PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  connect(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY);
} else {
  showLobbyStatus("本环境暂未连接答题服务。");
}
