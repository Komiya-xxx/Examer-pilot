import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  authClient, browserStorage, expectEdgeJson, localApiConfig, localDatabase, localFetch, localOrigin, signIn,
} from "./support/local-supabase.mjs";

test("local Stage 2 anonymous identity, saved-session recovery and access control", async (t) => {
  const { api, publicKey } = localApiConfig();

  assert.equal(localDatabase("select count(*) from public.evaluation_rounds where status = 'open'"), "0",
    "Run on an isolated local database with no open round");

  const runId = randomUUID();
  const activeRound = randomUUID();
  const closedRound = randomUUID();
  const missingRound = randomUUID();
  const activeSession = randomUUID();
  const closedSession = randomUUID();
  const question = randomUUID();
  const version = randomUUID();
  const secondQuestion = randomUUID();
  const secondVersion = randomUUID();
  const activeQuestion = randomUUID();
  const closedQuestion = randomUUID();
  const secondActiveQuestion = randomUUID();
  const ratedAssignment = randomUUID();
  const runUsers = `select id from auth.users where is_anonymous is true
    and raw_user_meta_data->>'examerframe_test_run' = '${runId}'`;
  const runRounds = `('${activeRound}', '${closedRound}')`;
  const runQuestions = `('${question}', '${secondQuestion}')`;

  t.after(() => {
    localDatabase(`
      begin;
      create temporary table fixture_sessions on commit drop as
        select id from public.sessions where participant_id in (${runUsers});
      create temporary table fixture_assignments on commit drop as
        select id from public.session_questions where session_id in (select id from fixture_sessions);
      create temporary table fixture_responses on commit drop as
        select id from public.responses where session_question_id in (select id from fixture_assignments);
      delete from public.ratings where response_id in (select id from fixture_responses);
      delete from public.responses where id in (select id from fixture_responses);
      delete from public.session_questions where id in (select id from fixture_assignments);
      delete from public.sessions where id in (select id from fixture_sessions);
      delete from public.round_questions where round_id in ${runRounds};
      delete from public.evaluation_rounds where id in ${runRounds};
      delete from public.question_versions where question_id in ${runQuestions};
      delete from public.questions where id in ${runQuestions};
      do $cleanup$
      begin
        if to_regclass('examerframe_private.participant_write_limits') is not null then
          delete from examerframe_private.participant_write_limits where participant_id in (${runUsers});
        end if;
      end
      $cleanup$;
      delete from auth.users where id in (${runUsers});
      commit;
    `);
  });

  function apiRequest(path, { token, headers, ...request } = {}) {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("apikey", publicKey);
    if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
    return localFetch(new URL(path, api), { ...request, headers: requestHeaders });
  }

  function getActiveRound(token) {
    return apiRequest("/functions/v1/get-active-round", { token, headers: { Origin: localOrigin } });
  }

  function resumeRound(token, roundId) {
    return apiRequest("/functions/v1/start-or-resume-session", {
      token,
      method: "POST",
      headers: { Origin: localOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ round_id: roundId }),
    });
  }

  const storage = browserStorage();
  const first = await signIn(authClient(api.origin, publicKey, storage), runId);
  const second = await signIn(authClient(api.origin, publicKey, browserStorage()), runId);
  assert.notEqual(first.user.id, second.user.id);

  await t.test("returns no active round or saved session before loading fixtures", async () => {
    const response = await getActiveRound(first.access_token);
    const body = await expectEdgeJson(response, 200, "Empty local round lookup");
    assert.deepEqual(body, { round: null, session: null });
  });

  localDatabase(`
    begin;
    insert into public.evaluation_rounds (id, slug, title, description, status, questions_per_session) values
      ('${activeRound}', 'stage2-${runId}-open', 'Synthetic open round', 'Stage 2 integration fixture', 'open', 2),
      ('${closedRound}', 'stage2-${runId}-closed', 'Synthetic closed round', 'Stage 2 integration fixture', 'closed', 1);
    insert into public.questions (id, external_id) values
      ('${question}', 'stage2-${runId}-first'), ('${secondQuestion}', 'stage2-${runId}-second');
    insert into public.question_versions (id, question_id, version_no, question_type, stem, options, review_status) values
      ('${version}', '${question}', 1, 'true_false', 'Synthetic statement one', '[]', 'published'),
      ('${secondVersion}', '${secondQuestion}', 1, 'true_false', 'Synthetic statement two', '[]', 'published');
    insert into public.round_questions (id, round_id, question_version_id, question_id) values
      ('${activeQuestion}', '${activeRound}', '${version}', '${question}'),
      ('${secondActiveQuestion}', '${activeRound}', '${secondVersion}', '${secondQuestion}'),
      ('${closedQuestion}', '${closedRound}', '${version}', '${question}');
    insert into public.sessions (id, round_id, participant_id) values
      ('${activeSession}', '${activeRound}', '${first.user.id}'),
      ('${closedSession}', '${closedRound}', '${second.user.id}');
    insert into public.session_questions (id, session_id, round_question_id, round_id, question_id, position) values
      ('${ratedAssignment}', '${activeSession}', '${activeQuestion}', '${activeRound}', '${question}', 1);
    insert into public.session_questions (session_id, round_question_id, round_id, question_id, position) values
      ('${activeSession}', '${secondActiveQuestion}', '${activeRound}', '${secondQuestion}', 2),
      ('${closedSession}', '${closedQuestion}', '${closedRound}', '${question}', 1);
    with answered as (
      insert into public.responses (session_question_id, selected_answer)
      values ('${ratedAssignment}', 'true')
      returning id
    )
    insert into public.ratings (response_id, quality) select id, 'high' from answered;
    commit;
  `);

  const round = {
    id: activeRound,
    title: "Synthetic open round",
    description: "Stage 2 integration fixture",
    questions_per_session: 2,
  };
  const active = {
    id: activeSession, round_id: activeRound, status: "in_progress", assigned_count: 2, rated_count: 1,
  };
  const closed = {
    id: closedSession, round_id: closedRound, status: "in_progress", assigned_count: 1, rated_count: 0,
  };

  await t.test("recreates the browser SDK client and restores the same anonymous identity and session", async () => {
    const reloaded = authClient(api.origin, publicKey, storage);
    const { data, error } = await reloaded.auth.getSession();
    assert.ok(!error, "The new client could not read its stored session");
    assert.equal(data.session?.user.id, first.user.id);
    assert.equal(data.session?.user.is_anonymous, true);

    const response = await getActiveRound(data.session.access_token);
    assert.ok([localOrigin, "*"].includes(response.headers.get("access-control-allow-origin")));
    const lookup = await expectEdgeJson(response, 200, "Round and first participant's saved session");
    assert.deepEqual(lookup, { round, session: active });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resumed = await resumeRound(data.session.access_token, activeRound);
      assert.deepEqual(await expectEdgeJson(resumed, 200, "Repeat resume"), { session: active });
    }
    assert.equal(localDatabase(`select count(*) from public.sessions where participant_id in (${runUsers})`), "2");
  });

  await t.test("restores the owner's closed-round session and hides absent or foreign sessions", async () => {
    const lookup = await getActiveRound(second.access_token);
    assert.deepEqual(await expectEdgeJson(lookup, 200, "Second participant's round lookup"),
      { round, session: closed });

    const restored = await resumeRound(second.access_token, closedRound);
    assert.deepEqual(await expectEdgeJson(restored, 200, "Closed-round resume"), { session: closed });

    for (const roundId of [closedRound, missingRound]) {
      const response = await resumeRound(first.access_token, roundId);
      const body = await expectEdgeJson(response, 409, "Closed foreign or missing round");
      assert.equal(body.code, "ROUND_NOT_OPEN");
    }
  });

  await t.test("rejects missing and forged bearer tokens", async () => {
    for (const token of [undefined, "forged.invalid.token"]) {
      const response = await getActiveRound(token);
      const body = await expectEdgeJson(response, 401, "Unauthenticated Edge request");
      assert.equal(body.code, "UNAUTHORIZED");
    }
  });

  await t.test("supports browser preflight and rejects protected calls from disallowed origins", async () => {
    const path = "/functions/v1/start-or-resume-session";
    const allowed = await localFetch(new URL(path, api), {
      method: "OPTIONS",
      headers: {
        Origin: localOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, apikey, content-type",
      },
    });
    // Local Kong can answer preflights itself and attach its own CORS headers.
    assert.ok(allowed.ok);
    assert.ok([localOrigin, "*"].includes(allowed.headers.get("access-control-allow-origin")));
    assert.match(allowed.headers.get("access-control-allow-methods") ?? "", /\bPOST\b/i);
    const allowedHeaders = allowed.headers.get("access-control-allow-headers") ?? "";
    for (const header of ["authorization", "apikey", "content-type"]) {
      assert.ok(allowedHeaders.toLowerCase().split(/\s*,\s*/).includes(header), `Preflight omitted ${header}`);
    }

    const forbidden = await apiRequest("/functions/v1/get-active-round", {
      token: first.access_token,
      headers: { Origin: "https://forbidden.example" },
    });
    const body = await expectEdgeJson(forbidden, 403, "Disallowed cross-origin Edge request");
    assert.equal(body.code, "ORIGIN_FORBIDDEN");
    assert.deepEqual(Object.keys(body).sort(), ["code", "message"]);
  });

  await t.test("denies ordinary clients direct REST table and privileged RPC access", async () => {
    for (const token of [undefined, first.access_token]) {
      const table = await apiRequest(`/rest/v1/sessions?select=id&id=eq.${activeSession}`, { token });
      const rpc = await apiRequest("/rest/v1/rpc/get_active_round_for_participant", {
        token,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_participant_id: first.user.id }),
      });
      assert.ok([401, 403, 404].includes(table.status), `REST table access returned ${table.status}`);
      assert.ok([401, 403, 404].includes(rpc.status), `REST RPC access returned ${rpc.status}`);
    }
  });
});
