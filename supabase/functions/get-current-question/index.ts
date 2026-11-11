import { participantEndpoint, readUuidBody } from "../_shared/participant.ts";

// Reading the current question is a POST, but it is a read: its RPC is not in
// the limited write set, so it never consumes a participant write slot.
Deno.serve(participantEndpoint(
  "POST",
  "get_current_question_for_participant",
  (request) => readUuidBody(request, "session_id"),
));
