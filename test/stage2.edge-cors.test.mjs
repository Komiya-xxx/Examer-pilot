import assert from "node:assert/strict";
import { test } from "node:test";
import { participantEndpoint } from "../supabase/functions/_shared/participant.ts";

const localOrigin = "http://127.0.0.1:4321";
const endpoint = "http://127.0.0.1:54321/functions/v1/start-or-resume-session";

test("the Edge handler restricts both preflight and actual requests by origin", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Origin policy must run before backend calls");
  });
  globalThis.Deno = {
    env: { get: (name) => name === "EXAMERFRAME_ALLOWED_ORIGINS" ? localOrigin : undefined },
  };
  t.after(() => { delete globalThis.Deno; });
  const handler = participantEndpoint("POST", "resume_session_for_participant");

  const preflight = (origin) => handler(new Request(endpoint, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  }));

  const allowed = await preflight(localOrigin);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), localOrigin);
  assert.equal(allowed.headers.get("access-control-allow-methods"), "POST");
  assert.match(allowed.headers.get("vary"), /\bOrigin\b/i);

  const forbiddenOrigin = "https://forbidden.example";
  for (const response of [
    await preflight(forbiddenOrigin),
    await handler(new Request(endpoint, { method: "POST", headers: { Origin: forbiddenOrigin } })),
  ]) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), {
      code: "ORIGIN_FORBIDDEN",
      message: "此来源无权访问答题接口。",
    });
  }
});
