import { participantEndpoint, readRatingBody } from "../_shared/participant.ts";

Deno.serve(participantEndpoint("POST", "submit_review_rating_for_participant", readRatingBody));
