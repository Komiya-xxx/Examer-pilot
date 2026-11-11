import { participantEndpoint, readAnswerBody } from "../_shared/participant.ts";

Deno.serve(participantEndpoint("POST", "submit_review_answer_for_participant", readAnswerBody));
