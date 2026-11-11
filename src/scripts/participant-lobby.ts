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

type QuestionStep = "answer" | "rating" | "completed";

interface QuestionView {
  assignment_id: string;
  position: number;
  question_type: "single_choice" | "multiple_choice" | "true_false";
  stem: string;
  options: { id: string; text: string }[];
}

interface CurrentQuestion {
  session: SessionSummary;
  step: QuestionStep;
  question: QuestionView | null;
  response_id: string | null;
}

const TYPE_LABELS: Record<QuestionView["question_type"], string> = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  true_false: "判断题",
};

// Judgment questions have no options in the data contract; they always show two choices.
const TRUE_FALSE_OPTIONS: readonly { id: string; text: string }[] = [
  { id: "true", text: "正确" },
  { id: "false", text: "错误" },
];

const ERROR_MESSAGES: Record<string, string> = {
  ROUND_NOT_OPEN: "当前没有可参与的批次，请稍后再试。",
  QUESTION_POOL_TOO_SMALL: "当前批次的题目不足，请稍后再试。",
  SESSION_NOT_FOUND: "没有找到你的答题会话。",
};

const button = document.querySelector<HTMLButtonElement>("#enter-lobby")!;
const status = document.querySelector<HTMLElement>("#lobby-status")!;
const roundSection = document.querySelector<HTMLElement>("#active-round")!;
const roundTitle = document.querySelector<HTMLElement>("#round-title")!;
const roundDescription = document.querySelector<HTMLElement>("#round-description")!;
const roundSize = document.querySelector<HTMLElement>("#round-size")!;
const sessionSection = document.querySelector<HTMLElement>("#saved-session")!;
const progress = document.querySelector<HTMLElement>("#session-progress")!;
const questionSection = document.querySelector<HTMLElement>("#current-question")!;
const questionProgress = document.querySelector<HTMLElement>("#question-progress")!;
const questionType = document.querySelector<HTMLElement>("#question-type")!;
const questionStem = document.querySelector<HTMLElement>("#question-stem")!;
const answerForm = document.querySelector<HTMLFormElement>("#answer-form")!;
const answerOptions = document.querySelector<HTMLFieldSetElement>("#answer-options")!;
const questionOptions = document.querySelector<HTMLOListElement>("#question-options")!;
const submitAnswer = document.querySelector<HTMLButtonElement>("#submit-answer")!;
const ratingForm = document.querySelector<HTMLFormElement>("#rating-form")!;
const ratingOptions = document.querySelector<HTMLFieldSetElement>("#rating-options")!;
const submitRating = document.querySelector<HTMLButtonElement>("#submit-rating")!;
const reviewOptions = document.querySelector<HTMLOListElement>("#review-options")!;

// The assignment whose answer is on screen; null when no form is showing.
let currentAssignmentId: string | null = null;
// Type of the question currently on screen; null when no form is showing.
let currentQuestionType: QuestionView["question_type"] | null = null;
// True while any request (refresh, answer, rating) is in flight; blocks re-entry.
let pending = false;
// Id of the session on screen; submit needs it alongside the assignment.
let currentSessionId: string | null = null;
// The response on screen while on the rating step; submit-rating needs it.
let currentResponseId: string | null = null;

// Whether the next click may create or resume an anonymous identity and session.
// False on the initial page load; true only once the user clicks Start / Re-start.
let mayStart = false;

function setButton(label: string, start: boolean) {
  mayStart = start;
  button.textContent = label;
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

  // Keep simultaneous first clicks in two tabs from creating two identities.
  return maySignIn && navigator.locks
    ? navigator.locks.request("examerframe-anonymous-sign-in", restoreOrSignIn)
    : restoreOrSignIn();
}

function renderRound(round: RoundPreview | null) {
  roundSection.hidden = !round;
  if (round) {
    roundTitle.textContent = round.title;
    roundDescription.textContent = round.description;
    roundSize.textContent = `每次答题预计发放 ${round.questions_per_session} 道题。`;
  }
}

function renderSession(session: SessionSummary | null) {
  sessionSection.hidden = !session;
  if (session) {
    progress.textContent = `已评价 ${session.rated_count} / ${session.assigned_count} 道题。`;
  }
}

function setFormVisible(visible: boolean) {
  if (!visible) {
    currentAssignmentId = null;
    currentQuestionType = null;
  }
  answerOptions.hidden = !visible;
  answerForm.hidden = !visible;
  submitAnswer.disabled = !visible;
}

function setRatingVisible(visible: boolean) {
  if (!visible) currentResponseId = null;
  ratingForm.hidden = !visible;
  ratingOptions.disabled = !visible;
  submitRating.disabled = !visible;
}

function hideQuestion() {
  questionSection.hidden = true;
  questionProgress.textContent = "";
  questionType.textContent = "";
  questionStem.textContent = "";
  questionOptions.replaceChildren();
  reviewOptions.replaceChildren();
  reviewOptions.hidden = true;
  setFormVisible(false);
  setRatingVisible(false);
}

// Fill the answer form fresh; the selected answer is never kept between renders.
function renderAnswerForm(question: QuestionView, type: QuestionView["question_type"]) {
  const options = type === "true_false" ? TRUE_FALSE_OPTIONS : question.options;
  const inputType = type === "multiple_choice" ? "checkbox" : "radio";
  const groupLabel = type === "multiple_choice" ? "选择一项或多项答案" : "选择一项答案";

  const legend = document.createElement("legend");
  legend.textContent = groupLabel;

  const inputs = options.map((option) => {
    const input = document.createElement("input");
    input.type = inputType;
    input.name = "answer";
    input.value = option.id;

    const text = document.createElement("label");
    text.append(input, document.createTextNode(` ${option.text}`));

    const item = document.createElement("li");
    item.append(text);
    return item;
  });

  questionOptions.replaceChildren(...inputs);
  answerOptions.querySelector("legend")?.replaceWith(legend);
  answerOptions.removeAttribute("aria-invalid");
  reviewOptions.hidden = true;
  currentAssignmentId = question.assignment_id;
  currentQuestionType = type;
  setFormVisible(true);
}

// "required" (nothing picked) or "invalid" (not a valid pick); null when fine.
function answerProblem(type: QuestionView["question_type"]): "required" | "invalid" | null {
  const inputs = answerOptions.querySelectorAll<HTMLInputElement>('input[name="answer"]');
  const count = [...inputs].filter((input) => input.checked).length;
  if (count === 0) return type === "multiple_choice" ? "required" : "invalid";
  if (type !== "multiple_choice" && count > 1) return "invalid";
  return null;
}

function readAnswer(type: QuestionView["question_type"]): string | string[] | boolean {
  const selected = [
    ...answerOptions.querySelectorAll<HTMLInputElement>('input[name="answer"]:checked'),
  ].map((input) => input.value);
  if (type === "multiple_choice") return selected;
  if (type === "true_false") return selected[0] === "true";
  return selected[0];
}

// Show the question's options read-only (no inputs) while the answer is locked.
function renderReadOnlyOptions(question: QuestionView, type: QuestionView["question_type"]) {
  const options = type === "true_false" ? TRUE_FALSE_OPTIONS : question.options;
  const items = options.map((option) => {
    const item = document.createElement("li");
    item.textContent = option.text;
    return item;
  });
  reviewOptions.replaceChildren(...items);
  reviewOptions.hidden = false;
}

function renderQuestion({ session, step, question, response_id }: CurrentQuestion) {
  renderSession(session);
  currentSessionId = session.id;
  if (step === "completed" || session.status === "completed") {
    hideQuestion();
    status.textContent = "该会话已完成，感谢参与。";
    setButton("刷新状态", false);
    return;
  }

  const type = question?.question_type;
  if (!question || !type || !(type in TYPE_LABELS)) {
    hideQuestion();
    status.textContent = "暂时无法加载当前题目，请重试。";
    setButton("重试", false);
    return;
  }

  // Populate the progress, type and stem, then reveal the section, before
  // deciding which branch (rating vs. answer form) this step renders.
  questionProgress.textContent = `第 ${question.position} 题 / 共 ${session.assigned_count} 题`;
  questionType.textContent = TYPE_LABELS[type];
  questionStem.textContent = question.stem;
  questionSection.hidden = false;

  if (step === "rating") {
    // Rating step: keep the stem and its options on screen read-only, hide the
    // answer form, and let the rating form take the post.
    setFormVisible(false);
    renderReadOnlyOptions(question, type);
    if (response_id) {
      // A new response means a fresh rating; clear any checked quality first.
      ratingForm.reset();
      ratingOptions.removeAttribute("aria-invalid");
      setRatingVisible(true);
      currentResponseId = response_id;
      status.textContent = "请评价这道题的整体质量。";
    } else {
      setRatingVisible(false);
      status.textContent = "已提交答案，等待评价";
    }
    setButton("刷新题目", false);
    return;
  }

  setRatingVisible(false);
  renderAnswerForm(question, type);
  status.textContent = "请选择答案后提交。";
  setButton("刷新题目", false);
}

class LobbyRequestError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string) {
    super(message);
    this.code = code;
  }
}

function connect(url: string, publishableKey: string) {
  const client = createClient(url, publishableKey, {
    auth: {
      detectSessionInUrl: false,
      storageKey: `examerframe-auth-${new URL(url).host}`,
    },
  });

  async function read<T>(
    name:
      | "get-active-round"
      | "start-or-resume-session"
      | "get-current-question"
      | "submit-answer"
      | "submit-rating",
    token: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const headers = new Headers({
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
    });
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
      const payload = (error && typeof error === "object" ? error : {}) as {
        code?: unknown;
        message?: unknown;
      };
      const code = typeof payload.code === "string" ? payload.code : undefined;
      const known = code ? ERROR_MESSAGES[code] : undefined;
      const fallback = typeof payload.message === "string" && payload.message
        ? payload.message
        : "暂时无法读取会话，请重试。";
      throw new LobbyRequestError(code, known ?? fallback);
    }
    return response.json();
  }

  async function loadCurrentQuestion(session: SessionSummary, accessToken: string) {
    renderSession(session);
    const current = await read<CurrentQuestion>("get-current-question", accessToken, {
      session_id: session.id,
    });
    renderQuestion(current);
  }

  // Ask the server which question is current, remembering the session on screen.
  // Used after a successful rating, where the current session is already known.
  async function reloadCurrent(accessToken: string) {
    const sessionId = currentSessionId;
    if (!sessionId) return;
    const current = await read<CurrentQuestion>("get-current-question", accessToken, {
      session_id: sessionId,
    });
    renderQuestion(current);
  }

  function showError(error: unknown, allowStart: boolean) {
    hideQuestion();
    currentSessionId = null;
    const known = error instanceof LobbyRequestError ? error : undefined;
    status.textContent = known ? known.message : "暂时无法连接，请重试。";
    if (known?.code === "SESSION_NOT_FOUND") {
      setButton("重新开始", true);
    } else {
      setButton("重试", allowStart);
    }
  }

  // Single entry point for both reload and clicks. mayStart is true only when the
  // user explicitly clicked Start / Re-start; reload always passes false.
  async function refresh(allowStart: boolean) {
    // Never let a refresh race an in-flight answer or rating submit.
    if (pending) return;
    pending = true;
    button.disabled = true;
    status.textContent = "正在查看参与状态…";

    try {
      const identity = await getAnonymousSession(client, allowStart);
      if (!identity) {
        hideQuestion();
        status.textContent = "点击「开始」以匿名参与。";
        setButton("开始", true);
        return;
      }

      const lobby = await read<Lobby>("get-active-round", identity.access_token);
      renderRound(lobby.round);

      // The lobby returns this participant's latest in-progress owned session
      // independently of whether the batch is still open; use it directly.
      if (lobby.session) {
        await loadCurrentQuestion(lobby.session, identity.access_token);
        return;
      }

      hideQuestion();
      if (!lobby.round) {
        status.textContent = "当前没有开放的批次，请稍后再查看。";
        setButton("刷新状态", false);
        return;
      }

      if (!allowStart) {
        status.textContent = "当前批次可参与，点击「开始」领取题目。";
        setButton("开始", true);
        return;
      }

      status.textContent = "正在准备题目…";
      const started = await read<{ session: SessionSummary | null }>(
        "start-or-resume-session",
        identity.access_token,
        { round_id: lobby.round.id },
      );
      const session = started.session;
      if (!session) {
        hideQuestion();
        status.textContent = "暂时无法创建答题会话，请重试。";
        setButton("重试", true);
        return;
      }

      await loadCurrentQuestion(session, identity.access_token);
    } catch (error) {
      showError(error, allowStart);
    } finally {
      pending = false;
      button.disabled = false;
    }
  }

  button.addEventListener("click", () => {
    void refresh(mayStart);
  });

  // Post the selected answer, then show that question's rating step. On any
  // failure the choices stay checked and the user can press Submit again.
  async function submit() {
    const type = currentQuestionType;
    const assignmentId = currentAssignmentId;
    const sessionId = currentSessionId;
    if (pending || !assignmentId || !type || !sessionId) return;

    const problem = answerProblem(type);
    if (problem) {
      // Radios do not take "required"; check the group ourselves and say why.
      answerOptions.setAttribute("aria-invalid", "true");
      status.textContent = problem === "required" ? "请至少选择一项答案。" : "请选择一项答案。";
      answerOptions.querySelector<HTMLInputElement>('input[name="answer"]')?.focus();
      return;
    }

    const answer = readAnswer(type);
    pending = true;
    submitAnswer.disabled = true;
    button.disabled = true;
    status.textContent = "正在提交答案…";

    try {
      const identity = await getAnonymousSession(client, false);
      if (!identity) {
        status.textContent = "会话已失效，请刷新后重试。";
        setButton("刷新状态", false);
        submitAnswer.disabled = false;
        return;
      }
      await read<{ response_id: string; step: QuestionStep }>(
        "submit-answer",
        identity.access_token,
        { session_id: sessionId, assignment_id: assignmentId, answer },
      );
      // Reload the current question so the central renderQuestion draws the
      // rating step with its read-only options. On failure the checked answer
      // stays put and the user may resubmit.
      await reloadCurrent(identity.access_token);
    } catch (error) {
      // Keep whatever the user checked so a retry is one click away.
      const known = error instanceof LobbyRequestError ? error : undefined;
      status.textContent = known ? known.message : "提交失败，请重试。";
      submitAnswer.disabled = false;
    } finally {
      pending = false;
      button.disabled = false;
    }
  }

  // Post the chosen quality, then load whatever the server says comes next.
  // On failure the choice stays checked and the user can press Submit again.
  async function submitRatingValue() {
    const responseId = currentResponseId;
    if (pending || !responseId) return;

    const quality = ratingForm.querySelector<HTMLInputElement>(
      'input[name="quality"]:checked',
    )?.value;
    if (!quality) {
      ratingOptions.setAttribute("aria-invalid", "true");
      status.textContent = "请选择题目整体质量。";
      ratingForm.querySelector<HTMLInputElement>('input[name="quality"]')?.focus();
      return;
    }

    pending = true;
    submitRating.disabled = true;
    button.disabled = true;
    status.textContent = "正在提交评价…";

    try {
      const identity = await getAnonymousSession(client, false);
      if (!identity) {
        status.textContent = "会话已失效，请刷新后重试。";
        setButton("刷新状态", false);
        submitRating.disabled = false;
        return;
      }
      // The same response id and quality are idempotent on the server, so a
      // retry after a timeout never creates a second rating.
      await read<{ rating_id: string; session: SessionSummary }>(
        "submit-rating",
        identity.access_token,
        { response_id: responseId, quality },
      );
      setRatingVisible(false);
      status.textContent = "已提交评价，正在加载下一题…";
      try {
        await reloadCurrent(identity.access_token);
      } catch {
        // The rating is already saved; ask the user to refresh rather than
        // inviting a resubmit that would only repeat it.
        showError(new LobbyRequestError(undefined, "评价已提交，请刷新以继续。"), false);
      }
    } catch (error) {
      // Keep the rating checked so a retry is one click away.
      const known = error instanceof LobbyRequestError ? error : undefined;
      status.textContent = known ? known.message : "评价提交失败，请重试。";
      submitRating.disabled = false;
    } finally {
      pending = false;
      button.disabled = false;
    }
  }

  answerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  ratingForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitRatingValue();
  });

  void refresh(false);
}

if (PUBLIC_SUPABASE_URL && PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
  connect(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY);
} else {
  status.textContent = "暂时无法连接，请稍后再试。";
}
