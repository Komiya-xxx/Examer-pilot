import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  authClient, browserStorage, expectEdgeJson, localApiConfig, localDatabase, localFetch, localOrigin, signIn,
} from "./support/local-supabase.mjs";

test("local Stage 3 question distribution and recovery", async (t) => {
  const { api, publicKey } = localApiConfig();
  assert.equal(localDatabase("select count(*) from public.evaluation_rounds where status = 'open'"), "0",
    "Run on an isolated local database with no open round");

  const runId = randomUUID();
  const roundId = randomUUID();
  const candidates = [1, 2].map((number) => ({
    questionId: randomUUID(),
    versionId: randomUUID(),
    associationId: randomUUID(),
    stem: "Synthetic statement " + number,
    options: [{ id: "B", text: "First option" }, { id: "A", text: "Second option" }],
  }));
  const questionIds = candidates.map(({ questionId }) => "'" + questionId + "'").join(", ");

  t.after(() => {
    localDatabase(`
      begin;
      create temporary table test_assignments on commit drop as
        select id from public.session_questions where round_id = '${roundId}';
      create temporary table test_responses on commit drop as
        select id from public.responses where session_question_id in (select id from test_assignments);
      delete from public.ratings where response_id in (select id from test_responses);
      delete from public.responses where id in (select id from test_responses);
      delete from public.session_questions where id in (select id from test_assignments);
      delete from public.sessions where round_id = '${roundId}';
      delete from public.round_questions where round_id = '${roundId}';
      delete from public.evaluation_rounds where id = '${roundId}';
      delete from public.question_versions where question_id in (${questionIds});
      delete from public.questions where id in (${questionIds});
      do $cleanup$
      begin
        if to_regclass('examerframe_private.participant_write_limits') is not null then
          delete from examerframe_private.participant_write_limits where participant_id in (
            select id from auth.users where is_anonymous is true
              and raw_user_meta_data->>'examerframe_test_run' = '${runId}'
          );
        end if;
      end
      $cleanup$;
      delete from auth.users where is_anonymous is true
        and raw_user_meta_data->>'examerframe_test_run' = '${runId}';
      commit;
    `);
  });

  localDatabase(`
    begin;
    insert into public.evaluation_rounds (id, slug, title, status, questions_per_session)
      values ('${roundId}', 'stage3-${runId}', 'Synthetic distribution round', 'open', 2);
    ${candidates.map(({ questionId, versionId, associationId, stem, options }, index) => `
      insert into public.questions (id, external_id) values ('${questionId}', 'stage3-${runId}-${index}');
      insert into public.question_versions (id, question_id, version_no, question_type, stem, options, review_status)
        values ('${versionId}', '${questionId}', 1, 'single_choice', '${stem}',
          '${JSON.stringify(options.map(option => ({ ...option, fixture_metadata: "private" })))}', 'published');
      insert into public.round_questions (id, round_id, question_version_id, question_id)
        values ('${associationId}', '${roundId}', '${versionId}', '${questionId}');
    `).join("\n")}
    commit;
  `);

  function apiPost(path, identity, body) {
    return localFetch(new URL(path, api), {
      method: "POST",
      headers: {
        apikey: publicKey,
        Authorization: "Bearer " + identity.access_token,
        Origin: localOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  const start = (identity) =>
    apiPost("/functions/v1/start-or-resume-session", identity, { round_id: roundId });
  const current = (identity, sessionId) =>
    apiPost("/functions/v1/get-current-question", identity, { session_id: sessionId });
  const newIdentity = () => signIn(authClient(api.origin, publicKey, browserStorage()), runId);
  const readStart = async (identity, label) =>
    (await expectEdgeJson(await start(identity), 200, label)).session;
  const snapshot = () => JSON.parse(localDatabase(`
    select coalesce(json_agg(row_to_json(assignment) order by assignment.session_id, assignment.position), '[]')
    from (
      select id, session_id, round_question_id, position
      from public.session_questions
      where round_id = '${roundId}'
    ) as assignment;
  `));

  const first = await newIdentity();
  const second = await newIdentity();
  const third = await newIdentity();
  const withoutSession = await newIdentity();
  let savedSession;
  let savedAssignments;
  let savedQuestion;

  const candidatesById = candidates.map(({ associationId }) => associationId).sort();
  await t.test("concurrent starts by one user persist one session and a fixed list", async () => {
    const sessions = await Promise.all([1, 2, 3, 4].map((attempt) => readStart(first, "Start " + attempt)));
    savedSession = sessions[0];
    assert.deepEqual(savedSession, {
      id: savedSession.id, round_id: roundId, status: "in_progress", assigned_count: 2, rated_count: 0,
    });
    for (const session of sessions) assert.deepEqual(session, savedSession);
    assert.equal(localDatabase(`select count(*) from public.sessions where round_id = '${roundId}'`), "1");
    savedAssignments = snapshot();
    assert.deepEqual(savedAssignments.map(({ position }) => position), [1, 2]);
    assert.deepEqual(savedAssignments.map(({ round_question_id }) => round_question_id).sort(), candidatesById);
    assert.ok(savedAssignments.every(({ session_id }) => session_id === savedSession.id));
  });
  if (!savedAssignments?.length) return;

  await t.test("returns only the first assigned question with public fields and options in order", async () => {
    const firstAssignment = savedAssignments[0];
    const candidate = candidates.find(({ associationId }) => associationId === firstAssignment.round_question_id);
    savedQuestion = {
      session: savedSession,
      step: "answer",
      response_id: null,
      question: {
        assignment_id: firstAssignment.id, position: 1, question_type: "single_choice",
        stem: candidate.stem, options: candidate.options,
      },
    };
    assert.deepEqual(await expectEdgeJson(await current(first, savedSession.id), 200, "Current question"), savedQuestion);
    assert.deepEqual(await readStart(first, "Repeated start"), savedSession);
    assert.deepEqual(snapshot(), savedAssignments);
  });

  await t.test("hides foreign or unknown sessions and rejects invalid bodies and direct RPC access", async () => {
    const foreign = await expectEdgeJson(await current(second, savedSession.id), 404, "Foreign session");
    const missing = await expectEdgeJson(await current(second, randomUUID()), 404, "Unknown session");
    assert.equal(foreign.code, "SESSION_NOT_FOUND");
    assert.deepEqual(Object.keys(foreign).sort(), ["code", "message"]);
    assert.deepEqual(foreign, missing);

    for (const body of [{ session_id: "invalid" }, { session_id: savedSession.id, participant_id: first.user.id }]) {
      const response = await apiPost("/functions/v1/get-current-question", first, body);
      assert.equal((await expectEdgeJson(response, 400, "Invalid current-question request")).code, "INVALID_REQUEST");
    }
    for (const [rpc, args] of [
      ["start_or_resume_session_for_participant", { p_round_id: roundId }],
      ["get_current_question_for_participant", { p_session_id: savedSession.id }],
    ]) {
      const direct = await apiPost(`/rest/v1/rpc/${rpc}`, first, { ...args, p_participant_id: first.user.id });
      assert.ok([401, 403, 404].includes(direct.status), "Direct RPC access returned " + direct.status);
    }
  });

  await t.test("concurrent new participants receive distinct least-issued candidates", async () => {
    localDatabase(`update public.evaluation_rounds set questions_per_session = 1 where id = '${roundId}'`);
    const [left, right] = await Promise.all([readStart(second, "Second user"), readStart(third, "Third user")]);
    assert.notEqual(left.id, right.id);
    assert.equal(left.assigned_count, 1);
    assert.equal(right.assigned_count, 1);
    const assignments = snapshot();
    // The first session gave both candidates one assignment. After the first new user
    // gets either candidate, the other has strictly lower coverage.
    const next = assignments.filter(({ session_id }) => session_id === left.id || session_id === right.id);
    assert.deepEqual(next.map(({ round_question_id }) => round_question_id).sort(), candidatesById);
    assert.deepEqual(assignments.filter(({ session_id }) => session_id === savedSession.id), savedAssignments);
  });

  await t.test("insufficient pool writes neither a session nor assignments", async () => {
    localDatabase(`update public.evaluation_rounds set questions_per_session = 3 where id = '${roundId}'`);
    const before = snapshot();
    const error = await expectEdgeJson(await start(withoutSession), 409, "Insufficient question pool");
    assert.equal(error.code, "QUESTION_POOL_TOO_SMALL");
    assert.equal(localDatabase(`select count(*) from public.sessions
      where round_id = '${roundId}' and participant_id = '${withoutSession.user.id}'`), "0");
    assert.deepEqual(snapshot(), before);
  });

  await t.test("closing the round and retiring the versions preserves the original assignments", async () => {
    const before = snapshot();
    localDatabase(`
      begin;
      update public.evaluation_rounds set status = 'closed' where id = '${roundId}';
      update public.round_questions set is_active = false where round_id = '${roundId}';
      update public.question_versions set review_status = 'retired' where question_id in (${questionIds});
      commit;
    `);
    assert.equal((await expectEdgeJson(await start(withoutSession), 409, "Closed round")).code, "ROUND_NOT_OPEN");
    assert.deepEqual(await readStart(first, "Resume closed round"), savedSession);
    assert.deepEqual(await expectEdgeJson(await current(first, savedSession.id), 200, "Retired assigned question"),
      savedQuestion);
    assert.deepEqual(snapshot(), before);
  });
});
