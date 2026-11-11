import { participantEndpoint, readUuidBody } from "../_shared/participant.ts";

Deno.serve(participantEndpoint(
  "POST",
  "start_next_review_session_for_participant",
  (request) => readUuidBody(request, "previous_session_id"),
));
