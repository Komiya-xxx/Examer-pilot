begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);
select ok(
    not has_schema_privilege('anon', 'examerframe_private', 'usage')
    and not has_table_privilege('authenticated', 'examerframe_private.question_feedback', 'select')
    and not has_table_privilege('service_role', 'examerframe_private.question_feedback', 'insert')
    and has_table_privilege('service_role', 'examerframe_private.question_feedback', 'select'),
    'Answer keys are private and the API role cannot write them'
);
select ok(
    not has_function_privilege('anon', 'public.get_review_session_for_participant(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.submit_review_answer_for_participant(uuid,uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.submit_review_rating_for_participant(uuid,uuid,text)', 'execute'),
    'Review operations require the trusted Edge role'
);

select gen_random_uuid() as owner, gen_random_uuid() as other \gset
insert into public.evaluation_rounds (slug, title, status, questions_per_session)
values ('review-db-fixture', 'Synthetic review batch', 'open', 3)
returning id as round \gset
insert into public.sessions (round_id, participant_id) values (:'round', :'owner') returning id as session \gset
insert into public.sessions (round_id, participant_id) values (:'round', :'other') returning id as foreign_session \gset

with logical as (
    insert into public.questions (external_id)
    values ('review-db-1'), ('review-db-2'), ('review-db-3') returning id, external_id
), versions as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    select id, 1,
        case external_id when 'review-db-1' then 'single_choice'
            when 'review-db-2' then 'multiple_choice' else 'true_false' end,
        'Synthetic statement',
        case external_id when 'review-db-3' then '[]'::jsonb
            else '[{"id":"A","text":"Alpha"},{"id":"B","text":"Beta"},{"id":"C","text":"Gamma"}]'::jsonb end,
        'published'
    from logical returning id, question_id
)
insert into public.round_questions (round_id, question_version_id, question_id)
select :'round', id, question_id from versions;

insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
select rq.question_version_id,
    case q.external_id when 'review-db-1' then '"A"'::jsonb
        when 'review-db-2' then '["A","C"]'::jsonb else 'false'::jsonb end,
    'Synthetic private explanation ' || right(q.external_id, 1)
from public.round_questions rq join public.questions q on q.id = rq.question_id where rq.round_id = :'round';

insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
select :'session', rq.id, rq.round_id, q.id, right(q.external_id, 1)::integer
from public.round_questions rq join public.questions q on q.id = rq.question_id where rq.round_id = :'round';
select id as a1 from public.session_questions where session_id = :'session' and position = 1 \gset
select id as a2 from public.session_questions where session_id = :'session' and position = 2 \gset
select id as a3 from public.session_questions where session_id = :'session' and position = 3 \gset

set local role service_role;
select throws_ok(format('select public.get_review_session_for_participant(%L,%L)', :'other', :'session'),
    'PT404', 'SESSION_NOT_FOUND', 'Another learner cannot read the session');
select throws_ok(format('select public.submit_review_answer_for_participant(%L,%L,%L,%L)',
        :'other', :'foreign_session', :'a3', 'false'),
    'PT404', 'ASSIGNMENT_NOT_FOUND', 'An assignment must belong to the given owned session');
select ok(not (public.get_review_session_for_participant(:'owner', :'session')::text ~ 'standard_answer|Synthetic private explanation'),
    'Unanswered assignments expose no private material');
select throws_ok(format('select public.submit_review_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a3', '"false"'),
    'PT400', 'INVALID_ANSWER', 'Invalid answers cannot open the feedback');

select public.submit_review_answer_for_participant(:'owner', :'session', :'a3', 'true') as third \gset
select is(:'third'::jsonb #>> '{questions,2,response,feedback,correct}', 'false', 'An out-of-order answer can be graded incorrect');
select is(:'third'::jsonb #> '{questions,2,response,feedback,standard_answer}', 'false'::jsonb, 'A false key is returned as a boolean');
select is(:'third'::jsonb #>> '{questions,2,response,feedback,explanation}', 'Synthetic private explanation 3', 'The answered version supplies its explanation');
select is(:'third'::jsonb #> '{questions,0,response}', 'null'::jsonb, 'Skipping a question does not reveal its key');
select is(:'third'::jsonb #> '{questions,2,response,rating}', '{"quality":"medium","source":"default"}'::jsonb,
    'The answer and its default rating are written together');
select :'third'::jsonb #>> '{questions,2,response,id}' as r3 \gset
select is(public.submit_review_answer_for_participant(:'owner', :'session', :'a3', 'true') #>> '{questions,2,response,id}',
    :'r3', 'Retry returns the original response');
select throws_ok(format('select public.submit_review_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a3', 'false'),
    'PT409', 'ANSWER_ALREADY_SUBMITTED', 'An answered assignment cannot be changed');
select throws_ok(format('select public.submit_review_rating_for_participant(%L,%L,%L)', :'other', :'r3', 'low'),
    'PT404', 'RESPONSE_NOT_FOUND', 'Another learner cannot rate the response');

select is(public.submit_review_answer_for_participant(:'owner', :'session', :'a2', '["C","A","C"]') #>> '{questions,1,response,feedback,correct}',
    'true', 'Multiple-choice correctness uses the exact set independent of input order');
select is(public.submit_review_answer_for_participant(:'owner', :'session', :'a1', '"A"')->>'status',
    'completed', 'All answers complete the session regardless of order or explicit ratings');
select is(public.submit_review_rating_for_participant(:'owner', :'r3', 'high') #> '{questions,2,response,rating}',
    '{"quality":"high","source":"explicit"}'::jsonb, 'An explicit rating can replace the default after completion');
select is(public.submit_review_rating_for_participant(:'owner', :'r3', 'high') #>> '{questions,2,response,rating,quality}',
    'high', 'The same explicit rating is an idempotent retry');
select throws_ok(format('select public.submit_review_rating_for_participant(%L,%L,%L)', :'owner', :'r3', 'low'),
    'PT409', 'RATING_ALREADY_SUBMITTED', 'An explicit rating cannot be overwritten');
select is((select count(*) from public.ratings where response_id = :'r3'), 1::bigint,
    'Default replacement does not add another rating');
select is(public.get_review_session_for_participant(:'owner', :'session') #>> '{questions,0,response,feedback,correct}',
    'true', 'The completed session can still review its submitted answers');

select * from finish();
rollback;
