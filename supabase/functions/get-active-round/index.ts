import { participantEndpoint } from "../_shared/participant.ts";

Deno.serve(participantEndpoint("GET", "get_active_round_for_participant"));
