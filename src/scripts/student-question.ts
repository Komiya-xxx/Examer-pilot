import { formatAnswer, type Answer } from "./answer-format";

type Quality = "low" | "high";
type ResponseSnapshot = {
  id: string;
  selected_answer: Answer;
  correct: boolean | null;
  standard_answer: Answer | null;
  explanation: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  rating: Quality | null;
  comment: string | null;
  retry: { selected_answer: Answer; correct: boolean; submitted_at: string } | null;
};

export type StudentQuestion = {
  external_id: string;
  version_no: number;
  question_version_id: string;
  question_type: "single_choice" | "multiple_choice" | "true_false";
  stem: string;
  options: { id: string; text: string }[];
  response: ResponseSnapshot | null;
};

export type QuestionAction =
  | { action: "answer"; question_version_id: string; answer: Answer }
  | { action: "review"; response_id: string }
  | { action: "retry"; response_id: string; attempt_id: string; answer: Answer }
  | { action: "rate"; response_id: string; quality: Quality }
  | { action: "comment"; response_id: string; comment: string };

const labels = { single_choice: "单选题", multiple_choice: "多选题", true_false: "判断题" };
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function renderStudentQuestion(
  template: HTMLTemplateElement,
  initial: StudentQuestion,
  mistakes: boolean,
  save: (action: QuestionAction) => Promise<StudentQuestion>,
  remember: (() => void) | undefined,
  report: (error: unknown) => string,
) {
  const card = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  const node = <T extends HTMLElement = HTMLElement>(name: string) => card.querySelector<T>("[data-" + name + "]")!;
  const identifier = node("identifier");
  const versionId = initial.question_version_id;
  card.dataset.versionId = versionId;
  card.dataset.externalId = initial.external_id;
  identifier.id = "student-question-" + versionId;
  card.setAttribute("aria-labelledby", identifier.id);
  identifier.textContent = `${initial.external_id} · 第 ${initial.version_no} 版`;
  node("question-type").textContent = labels[initial.question_type];
  node("stem").textContent = initial.stem;

  const choices = initial.question_type === "true_false" ? [
    { id: "true", text: "正确" }, { id: "false", text: "错误" },
  ] : initial.options;
  const inputs = choices.map(({ id, text }) => {
    const entry = document.createElement("li");
    const label = document.createElement("label");
    label.className = "choice-option";
    const input = document.createElement("input");
    input.type = initial.question_type === "multiple_choice" ? "checkbox" : "radio";
    input.name = "answer";
    input.value = id;
    const description = document.createElement("span");
    description.textContent = initial.question_type === "true_false" ? text : id + "．" + text;
    label.append(input, description);
    entry.append(label);
    node("options").append(entry);

    const savedChoice = document.createElement("li");
    savedChoice.textContent = description.textContent;
    node("saved-options").append(savedChoice);
    return input;
  });

  const answerForm = node<HTMLFormElement>("answer-form");
  const submitAnswer = node<HTMLButtonElement>("submit-answer");
  const openReview = node<HTMLButtonElement>("open-review");
  const startRetry = node<HTMLButtonElement>("start-retry");
  const cancelRetry = node<HTMLButtonElement>("cancel-retry");
  const commentForm = node<HTMLFormElement>("comment-form");
  const commentInput = node<HTMLTextAreaElement>("comment-input");
  const commentButton = commentForm.querySelector<HTMLButtonElement>("button")!;
  const ratings = card.querySelectorAll<HTMLButtonElement>("[data-rating]");
  const answerStatus = node("answer-status");
  const feedbackStatus = node("feedback-status");

  let question = initial;
  let pending = false;
  let opened = !mistakes;
  let attemptId: string | null = null;

  function draw() {
    const response = question.response;
    const revealed = !!response && opened && attemptId === null;
    answerForm.hidden = !!response && attemptId === null;
    node<HTMLFieldSetElement>("answer-options").disabled = pending;
    submitAnswer.disabled = pending || !inputs.some((input) => input.checked);
    submitAnswer.textContent = attemptId ? "提交复练" : "提交答案";
    node("review-panel").hidden = !response;
    node("saved-options").hidden = !revealed;
    node("review-actions").hidden = !mistakes;
    openReview.hidden = opened;
    openReview.disabled = pending;
    startRetry.hidden = !revealed;
    startRetry.disabled = pending;
    cancelRetry.hidden = attemptId === null;
    cancelRetry.disabled = pending;
    node("verdict-panel").hidden = !revealed;
    node("feedback").hidden = !revealed;
    if (!response) return;

    const verdict = node("verdict");
    verdict.textContent = response.correct === null ? "暂不可判" : response.correct ? "答对" : "答错";
    verdict.dataset.result = response.correct === null ? "ungraded" : response.correct ? "correct" : "wrong";
    const displayAnswer = (answer: Answer) => formatAnswer(question.options, answer);
    node("saved-answer").textContent = displayAnswer(response.selected_answer);
    node("standard-answer").textContent = response.standard_answer === null ? "暂未提供" : displayAnswer(response.standard_answer);
    node("explanation").textContent = response.explanation ?? "暂未提供";
    node("review-time").textContent = response.reviewed_at ? "最近回看 " + dateFormat.format(new Date(response.reviewed_at)) : "";
    const retry = response.retry;
    node("retry-result").textContent = retry
      ? `最近复练 ${retry.correct ? "答对" : "答错"} · ${displayAnswer(retry.selected_answer)} · ${dateFormat.format(new Date(retry.submitted_at))}`
      : "";
    for (const button of ratings) {
      button.disabled = pending || response.rating !== null;
      button.setAttribute("aria-pressed", String(button.dataset.rating === response.rating));
    }
    node("saved-rating").textContent = response.rating ? "已保存 " + (response.rating === "low" ? "低" : "高") : "";
    commentForm.hidden = response.comment !== null;
    commentInput.disabled = commentButton.disabled = pending;
    const comment = node("saved-comment");
    comment.hidden = response.comment === null;
    comment.textContent = response.comment === null ? "" : "已保存意见\n" + response.comment;
  }

  async function submit(action: QuestionAction, status: HTMLElement, onSaved?: () => void) {
    if (pending) return;
    pending = true;
    status.textContent = "正在保存…";
    draw();
    try {
      question = await save(action);
      status.textContent = "";
      onSaved?.();
    } catch (error) {
      status.textContent = report(error);
    } finally {
      pending = false;
      draw();
    }
  }

  answerForm.addEventListener("change", () => {
    answerStatus.textContent = "";
    draw();
  });
  answerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = inputs.filter((input) => input.checked).map((input) => input.value);
    if (!selected.length) return;
    const answer = initial.question_type === "multiple_choice" ? selected
      : initial.question_type === "true_false" ? selected[0] === "true" : selected[0];
    if (attemptId && question.response) {
      void submit({
        action: "retry", response_id: question.response.id, attempt_id: attemptId, answer,
      }, answerStatus, () => { attemptId = null; opened = true; });
    } else if (!question.response) {
      void submit({ action: "answer", question_version_id: versionId, answer }, answerStatus);
    }
  });
  openReview.addEventListener("click", () => {
    if (question.response) {
      void submit({ action: "review", response_id: question.response.id }, answerStatus, () => { opened = true; });
    }
  });
  startRetry.addEventListener("click", () => {
    attemptId = crypto.randomUUID();
    for (const input of inputs) input.checked = false;
    answerStatus.textContent = "";
    draw();
    inputs[0]?.focus();
  });
  cancelRetry.addEventListener("click", () => {
    attemptId = null;
    answerStatus.textContent = "";
    draw();
    startRetry.focus();
  });
  for (const rating of ratings) {
    rating.addEventListener("click", () => {
      if (question.response && question.response.rating === null) {
        void submit({
          action: "rate", response_id: question.response.id, quality: rating.dataset.rating as Quality,
        }, feedbackStatus);
      }
    });
  }
  commentInput.addEventListener("input", () => {
    commentInput.removeAttribute("aria-invalid");
    feedbackStatus.textContent = "";
  });
  commentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!question.response || question.response.comment !== null) return;
    const comment = commentInput.value.trim();
    if (!comment) {
      commentInput.setAttribute("aria-invalid", "true");
      feedbackStatus.textContent = "请填写反馈意见。";
      commentInput.focus();
      return;
    }
    void submit({ action: "comment", response_id: question.response.id, comment }, feedbackStatus, () => {
      commentInput.value = "";
    });
  });
  if (remember) {
    card.addEventListener("focusin", remember);
    card.addEventListener("click", remember);
  }
  draw();
  return card;
}
