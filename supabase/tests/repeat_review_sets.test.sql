begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);
select ok(
    not has_function_privilege('anon', 'public.start_next_review_session_for_participant(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.allocate_participant_session(uuid,uuid,uuid)', 'execute')
    and has_function_privilege('service_role', 'public.start_next_review_session_for_participant(uuid,uuid)', 'execute'),
    'Only the server can allocate a new set'
);

select gen_random_uuid() as owner, gen_random_uuid() as other \gset
insert into public.evaluation_rounds (slug, title, status, questions_per_session)
values ('repeat-review-fixture', 'Synthetic repeat review batch', 'open', 10)
returning id as round \gset

with logical as (
    insert into public.questions (external_id)
    select 'repeat-review-' || n from generate_series(1, 20) as n returning id, external_id
), versions as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    select id, 1, 'true_false', external_id, '[]'::jsonb, 'published'
    from logical returning id, question_id
)
insert into public.round_questions (round_id, question_version_id, question_id, is_active)
select :'round', v.id, v.question_id, q.external_id <> 'repeat-review-20'
from versions v join logical q on q.id = v.question_id;

set local role service_role;
select public.start_or_resume_session_for_participant(:'owner', :'round') #>> '{session,id}' as first \gset
select is((select count(*) from public.session_questions where session_id = :'first'), 10::bigint,
    'The first set contains ten questions');
select throws_ok(format('select public.start_next_review_session_for_participant(%L,%L)', :'other', :'first'),
    'PT404', 'SESSION_NOT_FOUND', 'Another learner cannot request the next set');

select count(public.submit_review_answer_for_participant(:'owner', :'first', id, 'true'::jsonb)) as saved
from public.session_questions where session_id = :'first' and position in (1, 2, 4, 7, 10) \gset
select throws_ok(format('select public.start_next_review_session_for_participant(%L,%L)', :'owner', :'first'),
    'PT409', 'NEXT_SET_MIN_ANSWERS_REQUIRED', 'Five answers do not allow a new set even after visiting question ten');
select r.id as explicit_response from public.responses r join public.session_questions a on a.id = r.session_question_id
where a.session_id = :'first' and a.position = 1 \gset
select public.submit_review_rating_for_participant(:'owner', :'explicit_response', 'high') as reviewed \gset
-- The sixth answer may have no quality rating.
insert into public.responses (session_question_id, selected_answer)
select id, 'true'::jsonb from public.session_questions where session_id = :'first' and position = 6
returning id as unrated_response \gset

select round_question_id as old_association, question_id as revised_question from public.session_questions
where session_id = :'first' and position = 1 \gset
update public.round_questions set is_active = false where id = :'old_association';
with version as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    values (:'revised_question', 2, 'true_false', 'Revised synthetic statement', '[]'::jsonb, 'published')
    returning id, question_id
)
insert into public.round_questions (round_id, question_version_id, question_id)
select :'round', id, question_id from version;

select throws_ok(format('select public.start_next_review_session_for_participant(%L,%L)', :'owner', :'first'),
    'PT409', 'NEXT_SET_POOL_TOO_SMALL', 'A new version of a previous question does not fill a shortage');
select is((select count(*) from public.sessions where round_id = :'round'), 1::bigint,
    'An insufficient pool does not create a partial set');
select is(public.get_review_session_for_participant(:'owner', :'first') #>> '{status}', 'in_progress',
    'A failed allocation does not mutate an existing session');

update public.round_questions rq set is_active = true
where rq.round_id = :'round' and rq.question_id = (select id from public.questions where external_id = 'repeat-review-20');
select public.start_next_review_session_for_participant(:'owner', :'first') as payload \gset
select :'payload'::jsonb ->> 'session_id' as second \gset
select is(jsonb_array_length(:'payload'::jsonb -> 'questions'), 10, 'Six answers allow a new set of ten questions');
select is((select count(*) from public.session_questions a join public.session_questions b using (question_id)
    where a.session_id = :'first' and b.session_id = :'second'), 0::bigint,
    'None of the ten earlier questions can repeat, including the four that were skipped');
select ok(not exists (select 1 from jsonb_array_elements(:'payload'::jsonb -> 'questions') q
    where q -> 'response' is distinct from 'null'::jsonb), 'New assignments are unanswered and reveal no solutions');
select is(public.start_next_review_session_for_participant(:'owner', :'first') ->> 'session_id', :'second',
    'Retrying the same predecessor reuses its successor');
select is(public.get_active_round_for_participant(:'owner') #>> '{session,id}', :'second',
    'The lobby restores the next set on reload');
select is(public.start_or_resume_session_for_participant(:'owner', :'round') #>> '{session,id}', :'second',
    'The initial entry point also resumes the current set');
select is(public.get_current_question_for_participant(:'owner', :'first') #>> '{session,id}', :'first',
    'A cached client reads the exact old session rather than the latest one');
select is(public.submit_rating_for_participant(:'owner', :'explicit_response', 'high') #>> '{session,id}', :'first',
    'A legacy rating retry returns its own earlier session');
select is((select count(*) from public.responses r join public.session_questions a on a.id = r.session_question_id
    where a.session_id = :'first'), 6::bigint, 'The six earlier answers remain stored with no fabricated responses');
select is((select count(*) from public.ratings where response_id = :'unrated_response'), 0::bigint,
    'The earlier missing rating stays optional and unchanged');
select is(public.get_review_session_for_participant(:'owner', :'first') ->> 'status', 'completed',
    'A successful switch closes the previous set');
select is((select count(*) from public.session_questions a left join public.responses r on r.session_question_id = a.id
    where a.session_id = :'first' and r.id is null), 4::bigint, 'The four skipped questions remain unanswered');
select id as skipped from public.session_questions where session_id = :'first' and position = 3 \gset
select throws_ok(format('select public.submit_review_answer_for_participant(%L,%L,%L,%L)', :'owner', :'first', :'skipped', 'true'),
    'PT409', 'SESSION_COMPLETED', 'An old tab cannot add an answer to a skipped question after switching');

select count(public.submit_review_answer_for_participant(:'owner', :'second', id, 'true'::jsonb)) as saved
from public.session_questions where session_id = :'second' and position <= 6 \gset
update public.evaluation_rounds set status = 'closed' where id = :'round';
select throws_ok(format('select public.start_next_review_session_for_participant(%L,%L)', :'owner', :'second'),
    'PT409', 'ROUND_NOT_OPEN', 'A closed batch cannot issue a new set');
select * from finish();
rollback;
