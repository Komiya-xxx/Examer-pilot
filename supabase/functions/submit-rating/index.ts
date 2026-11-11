import { participantEndpoint, readRatingBody } from "../_shared/participant.ts";

// POST { response_id: UUID, quality: 'low' | 'medium' | 'high' }
// The participant id is always taken from the verified anonymous session, never
// from the request body, and the database validates that the response belongs to
// that participant and has not been rated yet.
Deno.serve(participantEndpoint("POST", "submit_rating_for_participant", readRatingBody));
