import { participantEndpoint, readAnswerBody } from "../_shared/participant.ts";

// POST { session_id: UUID, assignment_id: UUID, answer: string | string[] | boolean }
// The participant id is always taken from the verified anonymous session, never
// from the request body, and the database validates that the session, assignment
// and answer type belong to that participant.
Deno.serve(participantEndpoint("POST", "submit_answer_for_participant", readAnswerBody));
