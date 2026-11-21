begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

select gen_random_uuid() as alice, gen_random_uuid() as bob,
    gen_random_uuid() as outsider, gen_random_uuid() as anonymous, gen_random_uuid() as attempt \gset
insert into auth.users (id, is_anonymous, raw_app_meta_data)
values (:'alice', false, '{}'::jsonb),
       (:'bob', false, '{"examerframe_username":"student-test-bob"}'::jsonb),
       (:'outsider', false, '{}'::jsonb),
       (:'anonymous', true, '{"examerframe_username":"student-test-anon"}'::jsonb);
-- Auth Admin sets app metadata after inserting the user.
update auth.users set raw_app_meta_data = '{"examerframe_username":"student-test-alice"}' where id = :'alice';

select ok(
    not has_table_privilege('authenticated', 'examerframe_private.student_responses', 'select')
    and not has_function_privilege('anon', 'public.browse_student_catalog(uuid,integer,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.get_staff_student_feedback(text,integer)', 'execute'),
    'Students access protected records only through verified Edge calls');

insert into public.evaluation_rounds (slug, title, status, questions_per_session)
values ('student-v16-fixture', 'Synthetic student practice', 'open', 3)
returning id as fixture_round \gset

with bank as (
    insert into public.questions (external_id) values ('student-test-01'), ('student-test-02'), ('student-test-03')
    returning id, external_id
), versions as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    select id, 1, 'single_choice', 'Synthetic ' || external_id,
        '[{"id":"A","text":"Literal %_test"},{"id":"B","text":"Second option"}]'::jsonb,
        case external_id when 'student-test-03' then 'draft' else 'published' end
    from bank returning question_id, id, review_status
)
insert into public.round_questions (round_id, question_id, question_version_id, is_active)
select :'fixture_round', question_id, id, review_status = 'published' from versions;

select v.id as scored
from public.question_versions v join public.questions q on q.id = v.question_id
where q.external_id = 'student-test-01' \gset
select v.id as unscored
from public.question_versions v join public.questions q on q.id = v.question_id
where q.external_id = 'student-test-02' \gset
insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
values (:'scored', '"A"', 'Original synthetic explanation');

-- Keep old sources represented independently of the versioned student records.
with old_sessions as (
    insert into public.sessions (round_id, participant_id)
    select :'fixture_round', gen_random_uuid() from generate_series(1, 3) returning id
), assignments as (
    insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
    select s.id, rq.id, rq.round_id, rq.question_id, 1 from old_sessions s
    cross join public.round_questions rq where rq.question_version_id = :'scored' and rq.round_id = :'fixture_round'
    returning id
), answers as (
    insert into public.responses (session_question_id, selected_answer)
    select id, '"B"'::jsonb from assignments returning id
)
insert into public.ratings (response_id, quality, source)
select a.id, 'medium',
    (array['explicit','default','legacy'])[row_number() over (order by a.id)] from answers a;

set local role service_role;

select is(public.get_student_profile(:'alice'), jsonb_build_object('id', :'alice'::uuid, 'username', 'student-test-alice'),
    'The bound ID is the same as the Auth user ID');
select throws_ok(format('select public.get_student_profile(%L)', :'outsider'), 'PT403', 'STUDENT_ACCOUNT_REQUIRED',
    'An ordinary Auth account has no student profile');
select throws_ok(format('select public.get_student_profile(%L)', :'anonymous'), 'PT403', 'STUDENT_ACCOUNT_REQUIRED',
    'An anonymous identity cannot become a student via app metadata');
select is(public.browse_student_catalog(:'alice', 1, null, null) ->> 'total_count', '2',
    'Only the open round active published versions are visible');
select is(public.browse_student_catalog(:'alice', 1, '%_test', null) #>> '{matches,0,matched_option}',
    'Literal %_test', 'Search treats percent and underscore literally');
select throws_ok(format('select public.browse_student_catalog(%L,1,null,%L)', :'alice', 'student-test-03'),
    'PT404', 'QUESTION_NOT_FOUND', 'Locating a draft fails');
select ok(not (public.browse_student_catalog(:'alice', 1, null, null)::text ~ 'standard_answer|explanation'),
    'Unanswered questions contain no keys or explanation');
select is((select count(*) from examerframe_private.student_responses), 0::bigint, 'Browse and search save no responses');

select public.submit_student_answer(:'alice', :'scored', '"B"') as first \gset
select :'first'::jsonb #>> '{response,id}' as response_id \gset
select ok(:'first'::jsonb #>> '{response,correct}' = 'false'
    and :'first'::jsonb #>> '{response,selected_answer}' = 'B'
    and :'first'::jsonb #>> '{response,standard_answer}' = 'A',
    'The first answer is normalized and scored for its exact version');
select is(:'first'::jsonb #> '{response,rating}', 'null'::jsonb, 'Answering creates no rating');
select is(public.browse_student_catalog(:'bob', 1, null, null) #> '{questions,0,response}', 'null'::jsonb,
    'Another student receives no response or explanation from Alice');
select is(public.list_student_responses(:'bob', 1, true) ->> 'total_count', '0', 'Mistakes belong to the student');
select throws_ok(format('select public.review_student_mistake(%L,%L)', :'bob', :'response_id'), 'PT404',
    'RESPONSE_NOT_FOUND', 'Another student cannot mark Alice''s mistake as reviewed');

select is(public.submit_student_answer(:'alice', :'unscored', '"A"') #> '{response,correct}', 'null'::jsonb,
    'A missing answer key yields an ungraded response');
select is(public.list_student_responses(:'alice', 1, true) ->> 'total_count', '1', 'Ungraded does not count as wrong');
select is(public.browse_student_catalog(:'alice', null, null, null) ->> 'focus_version_id', :'unscored',
    'First answer persists an exact resume location');

select is(public.save_student_comment(:'alice', :'response_id', '  <b>synthetic note</b> ') #>> '{response,comment}',
    '<b>synthetic note</b>', 'Text-only feedback retains literal characters and trims surrounding spaces');
select is(public.save_student_comment(:'alice', :'response_id', '<b>synthetic note</b>') #> '{response,rating}',
    'null'::jsonb, 'Replaying a comment does not create a rating');
select throws_ok(format('select public.save_student_rating(%L,%L,%L)', :'alice', :'response_id', 'medium'), 'PT400',
    'INVALID_QUALITY', 'The new rating operation never accepts medium');
select is(public.save_student_rating(:'alice', :'response_id', 'low') #>> '{response,rating}',
    'low', 'A rating can be added after a text comment');

reset role;
update public.evaluation_rounds set starts_at = clock_timestamp() + interval '1 day' where id = :'fixture_round';
set local role service_role;
select is(public.browse_student_catalog(:'alice', 1, null, null) ->> 'total_count', '0',
    'The catalog respects the opening time');
reset role;
update public.round_questions set is_active = false
where question_version_id = :'scored' and round_id = :'fixture_round';
update public.question_versions set review_status = 'retired' where id = :'scored';
update public.evaluation_rounds set status = 'closed' where id = :'fixture_round';
set local role service_role;

select is(public.submit_student_answer(:'alice', :'scored', '"B"') #>> '{response,id}', :'response_id',
    'Exact answer replays after retirement and closing the round');
select is(public.list_student_responses(:'alice', 1, false) ->> 'total_count', '2',
    'Students can recover all their answers after closing the round');
select throws_ok(format('select public.submit_student_answer(%L,%L,%L)', :'alice', :'scored', '"A"'), 'PT409',
    'ANSWER_ALREADY_SUBMITTED', 'Changed answers conflict even if the version is retired');
select throws_ok(format('select public.submit_student_answer(%L,%L,%L)', :'bob', :'scored', '"B"'), 'PT404',
    'QUESTION_NOT_FOUND', 'A different student cannot start a response after the question is delisted');
select ok(public.review_student_mistake(:'alice', :'response_id') #>> '{response,reviewed_at}' is not null,
    'A retired question can still be reviewed');
select public.submit_student_retry(:'alice', :'response_id', :'attempt', '"A"') as retry \gset
select ok(:'retry'::jsonb #>> '{response,retry,correct}' = 'true'
    and :'retry'::jsonb #>> '{response,correct}' = 'false'
    and :'retry'::jsonb #>> '{response,rating}' = 'low', 'Retry does not change the grade or feedback of the first attempt');
select is(public.submit_student_retry(:'alice', :'response_id', :'attempt', '"A"'), :'retry'::jsonb,
    'Retry with the same attempt identifier and answer is idempotent');

select public.get_staff_student_feedback('student-test-01', 1) as editor \gset
select ok(:'editor'::jsonb ->> 'low_count' = '1'
    and :'editor'::jsonb ->> 'high_count' = '0'
    and :'editor'::jsonb ->> 'comment_count' = '1'
    and :'editor'::jsonb #>> '{comments,0,text}' = '<b>synthetic note</b>'
    and :'editor'::jsonb #>> '{historical,explicit,medium}' = '1'
    and :'editor'::jsonb #>> '{historical,default,medium}' = '1'
    and :'editor'::jsonb #>> '{historical,legacy,medium}' = '1',
    'Staff can read version-specific votes, comments, and separate old sources');

reset role;
select * from finish();
rollback;
