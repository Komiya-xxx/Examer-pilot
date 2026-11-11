import assert from "node:assert/strict";
import {
  authClient, browserStorage, expectEdgeJson, localApiConfig, localDatabase, localFetch, localOrigin, signIn,
} from "./support/local-supabase.mjs";
import { pilotFixture } from "./support/pilot-fixture.mjs";

// The stage 5 pilot flow, followed by the stage 7 write-limit case. They run in
// order because the limiter case needs the owner's window to be exactly full, so
// it can only start once the ordinary flow has made its writes.
const { api, publicKey } = localApiConfig();
const fixture = await pilotFixture();
const payload = (value) => JSON.stringify(value);

try {
  async function identity() {
    const participant = await signIn(authClient(api.origin, publicKey, browserStorage()), fixture.run);
    return participant;
  }
  const [own, other] = [await identity(), await identity()];

  // Every accepted write spends one stage 7 limiter slot; the pilot case uses far fewer than 60.
  async function call(route, body, status = 200, participant = own) {
    const response = await localFetch(new URL("/functions/v1/" + route, api), {
      method: "POST",
      headers: { apikey: publicKey, Authorization: "Bearer " + participant.access_token,
        "Content-Type": "application/json", Origin: localOrigin },
      body: payload(body),
    });
    return expectEdgeJson(response, status, route);
  }
  const { session } = await call("start-or-resume-session", { round_id: fixture.round });
  const current = () => call("get-current-question", { session_id: session.id });
  const assignments = JSON.parse(localDatabase(`select json_agg(id order by position)
    from public.session_questions where session_id='${session.id}'`));
  assert.equal(assignments.length, 3, "The pilot round must assign all three fixture questions");
  const skipAnswer = JSON.parse(localDatabase(`select case v.question_type
    when 'true_false' then 'false'::jsonb
    when 'multiple_choice' then jsonb_build_array(v.options->0->>'id') else v.options->0->'id' end
    from public.session_questions a join public.round_questions rq on rq.id=a.round_question_id
    join public.question_versions v on v.id=rq.question_version_id where a.id='${assignments[1]}'`));
  assert.equal((await call("submit-answer", { session_id: session.id, assignment_id: assignments[1], answer: skipAnswer },
    409)).code, "NOT_CURRENT_QUESTION", "A later assignment is not the current question");

  const types = new Set();
  for (let i = 0; i < 3; i++) {
    const state = await current();
    const q = state.question;
    assert.equal(q.position, i + 1, "Assignments are served in their fixed order");
    assert.equal(q.assignment_id, assignments[i]);
    assert.equal(state.step, "answer");
    types.add(q.question_type);

    const isBool = q.question_type === "true_false";
    const isMulti = q.question_type === "multiple_choice";
    // Multi-choice deliberately repeats a selection to check normalization.
    const answer = isBool ? false : isMulti ? [q.options[2].id, q.options[0].id, q.options[2].id] : q.options[0].id;
    const canonical = isMulti ? [q.options[0].id, q.options[2].id] : answer;
    const conflict = isBool ? true : isMulti ? [q.options[1].id] : q.options[1].id;
    const params = { session_id: session.id, assignment_id: q.assignment_id, answer };

    assert.equal((await call("submit-answer", params, 404, other)).code, "SESSION_NOT_FOUND",
      "Another participant cannot answer into the owner's session");
    assert.equal((await call("submit-answer", { ...params, answer: isMulti ? ["invalid-id"] : "invalid-id" }, 400)).code,
      "INVALID_ANSWER");

    const [saved, repeated] = await Promise.all([call("submit-answer", params), call("submit-answer", params)]);
    assert.equal(saved.step, "rating", "A saved answer moves the session to rating");
    assert.deepEqual(saved, repeated, "Repeating the same answer returns the saved response");
    assert.equal((await call("submit-answer", { ...params, answer: conflict }, 409)).code, "ANSWER_ALREADY_SUBMITTED");

    const stored = JSON.parse(localDatabase(`select selected_answer from public.responses where id='${saved.response_id}'`));
    assert.deepEqual(stored, canonical, "Multi-choice answers are stored uniquely and in option order");

    const pending = await current();
    assert.equal(pending.step, "rating", "The current step waits for the pending rating");
    assert.equal(pending.response_id, saved.response_id);
    assert.equal(pending.question.assignment_id, q.assignment_id);
    assert.equal("selected_answer" in pending, false, "The pending question does not echo the saved answer");

    const rating = { response_id: saved.response_id, quality: ["low", "medium", "high"][i] };
    assert.equal((await call("submit-rating", { ...rating, quality: "bad" }, 400)).code, "INVALID_QUALITY");
    assert.equal((await call("submit-rating", rating, 404, other)).code, "RESPONSE_NOT_FOUND",
      "Another participant cannot rate the owner's response");
    const [done, replay] = await Promise.all([call("submit-rating", rating), call("submit-rating", rating)]);
    assert.match(done.rating_id, /^[a-f0-9-]{36}$/i);
    assert.equal(done.rating_id, replay.rating_id, "Repeating the same rating is idempotent");
    assert.equal(done.session.rated_count, i + 1);
    assert.equal(done.session.status, i === 2 ? "completed" : "in_progress");
    assert.equal((await call("submit-rating", { ...rating, quality: i === 0 ? "high" : "low" }, 409)).code,
      "RATING_ALREADY_SUBMITTED");
  }
  assert.deepEqual([...types].sort(), ["multiple_choice", "single_choice", "true_false"],
    "All three answer shapes are exercised");

  const done = await current();
  assert.equal(done.session.status, "completed");
  assert.equal(done.step, "completed");
  assert.equal(done.question, null);
  assert.equal(done.response_id, null);

  {
    // Stage 7 counts accepted writes (start or resume, answer, rating) in a fixed
    // 60 second window anchored at the participant's first write. Seeding 59 at
    // clock_timestamp() makes the next start the 60th write of a live window, which
    // is still within the limit and must succeed on its own merits.
    fixture.seedWriteWindow(own.user.id);
    const resumed = await call("start-or-resume-session", { round_id: fixture.round });
    assert.equal(resumed.session.id, session.id, "The 60th accepted write resumes the existing session");
    const counter = () => JSON.parse(localDatabase(`select jsonb_build_object(
      'requests', requests, 'age', extract(epoch from (clock_timestamp() - window_started_at)))
      from examerframe_private.participant_write_limits where participant_id = '${own.user.id}'`));
    const afterStart = counter();
    assert.equal(afterStart.requests, 60, "The window now holds every accepted write");
    assert.ok(afterStart.age >= 0 && afterStart.age < 60, "The window seeded at clock_timestamp() is still live");

    // Valid shapes, so only the exhausted quota can explain a 429.
    const targets = JSON.parse(localDatabase(`select jsonb_build_object(
      'assignment_id', (select a.id from public.session_questions a
        where a.session_id = '${session.id}' order by a.position limit 1),
      'answer', (select case v.question_type when 'true_false' then 'false'::jsonb
        when 'multiple_choice' then jsonb_build_array(v.options->0->>'id') else v.options->0->'id' end
        from public.session_questions a join public.round_questions rq on rq.id = a.round_question_id
        join public.question_versions v on v.id = rq.question_version_id
        where a.session_id = '${session.id}' order by a.position limit 1),
      'response_id', (select r.id from public.responses r join public.session_questions a on a.id = r.session_question_id
        where a.session_id = '${session.id}' order by a.position limit 1))`));
    assert.match(targets.assignment_id, /^[a-f0-9-]{36}$/i);
    assert.match(targets.response_id, /^[a-f0-9-]{36}$/i);
    assert.ok(targets.answer !== undefined);

    async function expectLimited(route, body) {
      const response = await localFetch(new URL("/functions/v1/" + route, api), {
        method: "POST",
        headers: { apikey: publicKey, Authorization: "Bearer " + own.access_token,
          "Content-Type": "application/json", Origin: localOrigin },
        body: payload(body),
      });
      assert.equal(response.status, 429, route + " must be limited once the live window holds 60 writes");
      assert.equal(response.headers.get("access-control-expose-headers")?.split(",")
        .map(value => value.trim().toLowerCase()).includes("retry-after") ?? false, true,
        route + " must expose Retry-After to the browser via CORS");
      assert.equal(response.headers.get("retry-after")?.trim(), "60",
        route + " must send Retry-After: 60 while the seeded window is full");
      const error = await response.json();
      assert.equal(error.code, "RATE_LIMITED", route + " must report RATE_LIMITED");
      assert.deepEqual(Object.keys(error).sort(), ["code", "message"], route + " must not leak detail");
    }
    await expectLimited("submit-answer",
      { session_id: session.id, assignment_id: targets.assignment_id, answer: targets.answer });
    await expectLimited("submit-rating", { response_id: targets.response_id, quality: "low" });
    assert.equal(counter().requests, 60, "Rejected writes do not advance the window");

    // Reads stay unlimited and every participant has their own window.
    const read = await call("get-current-question", { session_id: session.id });
    assert.equal(read.session.status, "completed", "get-current-question still answers while writes are limited");
    assert.equal(read.step, "completed");
    const fresh = await identity();
    assert.notEqual((await call("start-or-resume-session", { round_id: fixture.round }, 200, fresh)).session.id, session.id,
      "Another participant still starts while the limited one waits");

    // Ordinary clients cannot reach the limiter or the participant RPCs directly.
    for (const token of [undefined, own.access_token]) {
      const headers = new Headers({ apikey: publicKey, "Content-Type": "application/json" });
      if (token) headers.set("Authorization", "Bearer " + token);
      for (const path of [
        "/rest/v1/examerframe_private.participant_write_limits?select=participant_id",
        "/rest/v1/rpc/take_participant_write_slot",
        "/rest/v1/rpc/start_or_resume_session_for_participant",
      ]) {
        const direct = await localFetch(new URL(path, api), {
          method: "POST", headers, body: payload({ p_participant_id: own.user.id }),
        });
        assert.ok([401, 403, 404].includes(direct.status),
          "Direct " + path + " access returned " + direct.status + (token ? " for a participant" : " for anon"));
      }
    }
    console.log("Pilot (stage 5 + stage 7): answer shapes, normalization, ownership, ordering, duplicates, recovery, "
      + "rating and completion passed; the 60th accepted write succeeded and further writes got 429 with "
      + "Retry-After: 60 exposed over CORS.");
  }
} finally {
  fixture.cleanup();
}
