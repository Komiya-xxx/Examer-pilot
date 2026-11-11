import { participantEndpoint, readUuidBody } from "../_shared/participant.ts";

Deno.serve(participantEndpoint("POST", "get_review_session_for_participant", (request) => readUuidBody(request, "session_id")));
