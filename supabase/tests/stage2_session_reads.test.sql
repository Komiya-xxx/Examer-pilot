begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(15);

\set participant_a '20000000-0000-4000-8000-0000000000a1'
\set participant_b '20000000-0000-4000-8000-0000000000a2'
\set round_open '20000000-0000-4000-8000-000000000101'
\set round_recent '20000000-0000-4000-8000-000000000102'
\set round_older '20000000-0000-4000-8000-000000000103'
\set round_completed '20000000-0000-4000-8000-000000000104'
\set round_draft '20000000-0000-4000-8000-000000000105'
\set round_tied '20000000-0000-4000-8000-000000000106'
\set session_open '20000000-0000-4000-8000-000000000201'
\set session_recent '20000000-0000-4000-8000-000000000203'
\set session_older '20000000-0000-4000-8000-000000000204'
\set session_completed '20000000-0000-4000-8000-000000000205'
\set session_tied '20000000-0000-4000-8000-000000000202'

select ok(
    not exists (
        select from pg_proc as procedure
        cross join lateral aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) as privilege
        where procedure.oid in (
            'public.get_active_round_for_participant(uuid)'::regprocedure,
            'public.resume_session_for_participant(uuid, uuid)'::regprocedure
        )
          and privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
    ),
    'Neither session RPC has default PUBLIC execute permission'
);

set local role anon;
select throws_ok(
    format('select public.get_active_round_for_participant(%L)', :'participant_a'),
    '42501', null, 'The unauthenticated role cannot call the round lookup'
);

set local role authenticated;
set local request.jwt.claim.sub = :'participant_a';
select throws_ok(
    format('select public.resume_session_for_participant(%L, %L)', :'participant_a', :'round_recent'),
    '42501', null, 'The authenticated role cannot call the session lookup even with its own ID'
);

set local role service_role;

insert into public.evaluation_rounds (id, slug, title, description, status, questions_per_session, starts_at, ends_at)
values
    (:'round_open', 'stage2-db-open', 'Open test round', 'Synthetic fixture', 'open', 1, now(), now() + interval '1 hour'),
    (:'round_recent', 'stage2-db-recent', 'Closed test round', '', 'closed', 3, null, null),
    (:'round_older', 'stage2-db-older', 'Older closed test round', '', 'closed', 1, null, null),
    (:'round_completed', 'stage2-db-completed', 'Completed test round', '', 'closed', 1, null, null),
    (:'round_draft', 'stage2-db-draft', 'Draft test round', '', 'draft', 1, null, null),
    (:'round_tied', 'stage2-db-tied', 'Closed test round with tied session time', '', 'closed', 1, null, null);

insert into public.sessions (id, round_id, participant_id, status, started_at, completed_at)
values
    (:'session_open', :'round_open', :'participant_b', 'in_progress', now(), null),
    (:'session_recent', :'round_recent', :'participant_a', 'in_progress', now() - interval '1 day', null),
    (:'session_older', :'round_older', :'participant_a', 'in_progress', now() - interval '2 days', null),
    (:'session_completed', :'round_completed', :'participant_a', 'completed', now() - interval '2 hours', now()),
    (:'session_tied', :'round_tied', :'participant_a', 'in_progress', now() - interval '1 day', null);

insert into public.questions (external_id)
values ('STAGE2-TEST-1'), ('STAGE2-TEST-2'), ('STAGE2-TEST-3');

insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
select id, 1, 'true_false', 'Synthetic stage 2 test question', '[]', 'published'
from public.questions
where external_id in ('STAGE2-TEST-1', 'STAGE2-TEST-2', 'STAGE2-TEST-3');

insert into public.round_questions (round_id, question_version_id, question_id)
select round.id, version.id, version.question_id
from public.evaluation_rounds as round
cross join public.question_versions as version
join public.questions as question on question.id = version.question_id
where question.external_id in ('STAGE2-TEST-1', 'STAGE2-TEST-2', 'STAGE2-TEST-3')
  and (
      round.id = :'round_recent'
      or (round.id in (:'round_open', :'round_completed') and question.external_id = 'STAGE2-TEST-1')
  );

insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
select session.id, association.id, session.round_id, association.question_id,
    row_number() over (partition by session.id order by question.external_id)::integer
from public.sessions as session
join public.round_questions as association on association.round_id = session.round_id
join public.questions as question on question.id = association.question_id
where session.id in (:'session_open', :'session_recent', :'session_completed');

insert into public.responses (session_question_id, selected_answer)
select id, 'true'
from public.session_questions
where (session_id = :'session_recent' and position <= 2)
   or session_id = :'session_completed';

insert into public.ratings (response_id, quality)
select response.id, 'medium'
from public.responses as response
join public.session_questions as assignment on assignment.id = response.session_question_id
where assignment.session_id in (:'session_recent', :'session_completed')
  and assignment.position = 1;

select is(
    public.get_active_round_for_participant(:'participant_a'),
    jsonb_build_object(
        'round', jsonb_build_object(
            'id', :'round_open'::uuid, 'title', 'Open test round',
            'description', 'Synthetic fixture', 'questions_per_session', 1
        ),
        'session', jsonb_build_object(
            'id', :'session_recent'::uuid, 'round_id', :'round_recent'::uuid,
            'status', 'in_progress', 'assigned_count', 3, 'rated_count', 1
        )
    ),
    'At the inclusive start time, return the open round and the latest own unfinished session'
);

select is(
    public.resume_session_for_participant(:'participant_a', :'round_recent') -> 'session',
    public.get_active_round_for_participant(:'participant_a') -> 'session',
    'A closed round is still resumable with identical persisted progress'
);

select is(
    public.resume_session_for_participant(:'participant_a', :'round_completed'),
    jsonb_build_object('session', jsonb_build_object(
        'id', :'session_completed'::uuid, 'round_id', :'round_completed'::uuid,
        'status', 'completed', 'assigned_count', 1, 'rated_count', 1
    )),
    'An explicit lookup returns an owned completed session and its counts'
);

select is(
    public.resume_session_for_participant(:'participant_b', :'round_recent'),
    '{"session":null}'::jsonb,
    'A participant cannot recover another participant''s session'
);

select is(
    public.resume_session_for_participant(:'participant_a', :'round_open'),
    '{"session":null}'::jsonb,
    'An open round without a session for this participant reports no session'
);

select is(
    (select count(*) from public.sessions
        where round_id = :'round_open' and participant_id = :'participant_a'),
    0::bigint,
    'A missing-session lookup does not create a session'
);

select throws_ok(
    format('insert into public.sessions (round_id, participant_id) values (%L, %L)',
        :'round_recent', :'participant_a'),
    '23505', null, 'A participant cannot have a second session in the same round'
);

select is(
    public.resume_session_for_participant(:'participant_a', :'round_recent') #>> '{session,id}',
    :'session_recent',
    'Retrying recovery after a duplicate attempt still returns the original session'
);

update public.evaluation_rounds set starts_at = now() + interval '1 minute' where id = :'round_open';
select is(
    public.get_active_round_for_participant(:'participant_a') -> 'round',
    'null'::jsonb,
    'A future open round, draft round, and closed rounds are excluded'
);

select is(
    public.get_active_round_for_participant(:'participant_a') #>> '{session,id}',
    :'session_recent',
    'An unfinished own session remains discoverable when no round is active'
);

update public.evaluation_rounds
set starts_at = now() - interval '1 hour', ends_at = now()
where id = :'round_open';

select is(
    public.get_active_round_for_participant(:'participant_b'),
    jsonb_build_object('round', null, 'session', jsonb_build_object(
        'id', :'session_open'::uuid, 'round_id', :'round_open'::uuid,
        'status', 'in_progress', 'assigned_count', 1, 'rated_count', 0
    )),
    'The end time is exclusive and does not prevent recovery of its existing session'
);

update public.evaluation_rounds set starts_at = null, ends_at = null where id = :'round_open';
select is(
    public.get_active_round_for_participant(:'participant_b') #>> '{round,id}',
    :'round_open',
    'An open round without either time boundary is active'
);

reset role;
select * from finish();
rollback;
