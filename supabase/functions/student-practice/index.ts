import { isUuid, participantEndpoint } from "../_shared/participant.ts";
import type { ParticipantAnswer, ReadStudentOperation } from "../_shared/participant.ts";

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value) &&
    [...value].length <= max && value.trim().length > 0;
}

function validAnswer(answer: unknown): answer is ParticipantAnswer {
  const isOption = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  return typeof answer === "boolean" || isOption(answer) ||
    (Array.isArray(answer) && answer.length > 0 && answer.every(isOption));
}

function validPage(page: unknown): page is number {
  return typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= 2_147_483_647;
}

const readOperation: ReadStudentOperation = async (request) => {
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { action, page = null, query = null, external_id = null, question_version_id, response_id, attempt_id } = body;

  switch (action) {
    case "profile":
      return { rpcName: "get_student_profile", args: {} };
    case "browse":
      if ((page !== null && !validPage(page)) || (query !== null && !validText(query, 200)) ||
        (external_id !== null && !validText(external_id, 200)) || (query !== null && external_id !== null)) return null;
      return {
        rpcName: "browse_student_catalog",
        args: { p_page: page, p_query: query?.trim() ?? null, p_external_id: external_id },
      };
    case "wrong":
    case "answered":
      return validPage(page)
        ? { rpcName: "list_student_responses", args: { p_page: page, p_wrong_only: action === "wrong" } }
        : null;
    case "position":
      if (!isUuid(question_version_id)) return null;
      return { rpcName: "save_student_position", args: { p_question_version_id: question_version_id } };
    case "answer":
      if (!isUuid(question_version_id)) return null;
      if (!validAnswer(body.answer)) return "INVALID_ANSWER";
      return { rpcName: "submit_student_answer", args: { p_question_version_id: question_version_id, p_answer: body.answer } };
    case "review":
      if (!isUuid(response_id)) return null;
      return { rpcName: "review_student_mistake", args: { p_response_id: response_id } };
    case "retry":
      if (!isUuid(response_id) || !isUuid(attempt_id)) return null;
      if (!validAnswer(body.answer)) return "INVALID_ANSWER";
      return {
        rpcName: "submit_student_retry",
        args: { p_response_id: response_id, p_attempt_id: attempt_id, p_answer: body.answer },
      };
    case "rate":
      if (!isUuid(response_id)) return null;
      if (body.quality !== "low" && body.quality !== "high") return "INVALID_QUALITY";
      return { rpcName: "save_student_rating", args: { p_response_id: response_id, p_quality: body.quality } };
    case "comment":
      if (!isUuid(response_id)) return null;
      if (!validText(body.comment, 2000)) return "INVALID_COMMENT";
      return { rpcName: "save_student_comment", args: { p_response_id: response_id, p_comment: body.comment.trim() } };
    default:
      return null;
  }
};

Deno.serve(participantEndpoint("POST", readOperation));
