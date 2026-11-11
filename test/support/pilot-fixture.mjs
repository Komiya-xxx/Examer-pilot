import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { localDatabase } from "./local-supabase.mjs";

// Stage 7 limits every accepted participant write to 60 per live 60 second window.
const writeLimit = 60;
const writeLimitsTable = "examerframe_private.participant_write_limits";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function literal(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function participantId(value, label) {
  assert.match(value, uuid, `${label} must be a UUID`);
  return literal(value);
}

// Loads the synthetic round used by both local integration cases and removes
// everything it wrote, including stage 7 limiter rows of the tagged test
// identities and the optional browser participant.
export async function pilotFixture({ feedback = false } = {}) {
  assert.equal(localDatabase("select count(*) from public.evaluation_rounds where status = 'open'"), "0",
    "Use an isolated local database with no open round");
  const run = randomUUID();
  const round = randomUUID();
  const examples = JSON.parse(await readFile(new URL("../fixtures/questions.json", import.meta.url), "utf8"));
  // Stage 7 must be installed: the write-limiter table is a hard requirement, and
  // its absence fails the fixture rather than silently relaxing the rate checks.
  assert.equal(
    localDatabase(`select to_regclass(${literal(writeLimitsTable)}) is not null`),
    "t",
    "The stage 7 participant write limiter is not installed (missing " + writeLimitsTable + ")",
  );
  const array = (values) => "array[" + values.join(", ") + "]";
  // Review material is optional so the fixture still loads where the review-mode
  // migration is absent; it only ever covers this run's own synthetic versions.
  const seedFeedback = feedback ? `
    insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
      select version.id,
             case version.question_type
               when 'single_choice' then version.options->0->'id'
               when 'multiple_choice' then jsonb_build_array(version.options->0->'id', version.options->-1->'id')
               when 'true_false' then 'true'::jsonb
             end,
             ${literal("本地合成题解析。")}
      from public.question_versions as version
      join public.questions as question on question.id = version.question_id
      where question.external_id like 'acceptance-${run}-%';` : "";
  const cleanupFeedback = feedback ? `
        delete from examerframe_private.question_feedback where question_version_id in
          (select version.id from public.question_versions as version
           join public.questions as question on question.id = version.question_id
           where question.external_id like 'acceptance-${run}-%');` : "";

  localDatabase(`
    begin;
    set local standard_conforming_strings = on;
    insert into public.evaluation_rounds (id, slug, title, status, questions_per_session)
      values ('${round}', 'acceptance-${run}', '本地合成题验收', 'open', ${examples.length});
    insert into public.questions (external_id)
      values ${examples.map((_, index) => `('acceptance-${run}-${index}')`).join(", ")};
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
      select question.id, example.version_no, example.question_type, example.stem,
             example.options::jsonb, 'published'
      from unnest(
        ${array(examples.map((_, index) => literal(`acceptance-${run}-${index}`)))},
        ${array(examples.map(({ version_no }) => Number(version_no)))}::integer[],
        ${array(examples.map(({ question_type }) => literal(question_type)))},
        ${array(examples.map(({ stem }) => literal(stem)))},
        ${array(examples.map(({ options }) => literal(JSON.stringify(options))))}
      ) as example(external_id, version_no, question_type, stem, options)
      join public.questions as question on question.external_id = example.external_id;
    insert into public.round_questions (round_id, question_version_id, question_id)
      select '${round}', version.id, version.question_id
      from public.question_versions as version
      join public.questions as question on question.id = version.question_id
      where question.external_id like 'acceptance-${run}-%';${seedFeedback}
    commit;
  `);

  return {
    run,
    round,
    // Makes the owner's next accepted write the limiter's 60th request of a live
    // window: exactly at the limit, so the next start-or-resume must succeed.
    seedWriteWindow(participantIdValue, requests = writeLimit - 1) {
      assert.ok(Number.isInteger(requests) && requests > 0 && requests < writeLimit,
        "A seeded write window must stay below the limit");
      const id = participantId(participantIdValue, "Seeded participant id");
      const seeded = localDatabase(`
        insert into ${writeLimitsTable} as limits (participant_id, window_started_at, requests)
        values (${id}, clock_timestamp(), ${requests})
        on conflict (participant_id) do update
        set window_started_at = clock_timestamp(), requests = excluded.requests;
        select requests from ${writeLimitsTable} where participant_id = ${id};
      `);
      assert.equal(seeded.split(/\r?\n/).at(-1), String(requests));
    },
    cleanup(browserUser) {
      const browserFilter = browserUser ? " or id = " + participantId(browserUser, "Browser identity") : "";
      const taggedUsers = `select id from auth.users where is_anonymous is true
        and (raw_user_meta_data->>'examerframe_test_run' = '${run}'${browserFilter})`;
      localDatabase(`
        begin;
        create temporary table test_sessions on commit drop as
          select id from public.sessions where round_id = '${round}' or participant_id in (${taggedUsers});
        create temporary table test_assignments on commit drop as
          select id from public.session_questions where session_id in (select id from test_sessions);
        create temporary table test_responses on commit drop as
          select id from public.responses where session_question_id in (select id from test_assignments);
        delete from public.ratings where response_id in (select id from test_responses);
        delete from public.responses where id in (select id from test_responses);
        delete from public.session_questions where id in (select id from test_assignments);
        delete from public.sessions where id in (select id from test_sessions);
        delete from public.round_questions where round_id = '${round}';
        delete from public.evaluation_rounds where id = '${round}';
        ${cleanupFeedback}
        delete from public.question_versions where question_id in
          (select id from public.questions where external_id like 'acceptance-${run}-%');
        delete from public.questions where external_id like 'acceptance-${run}-%';
        delete from ${writeLimitsTable} where participant_id in (${taggedUsers});
        delete from auth.users where id in (${taggedUsers});
        commit;
      `);
    },
  };
}
