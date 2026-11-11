import { participantEndpoint, readUuidBody } from "../_shared/participant.ts";

Deno.serve(participantEndpoint(
  "POST",
  "start_or_resume_session_for_participant",
  (request) => readUuidBody(request, "round_id"),
));
