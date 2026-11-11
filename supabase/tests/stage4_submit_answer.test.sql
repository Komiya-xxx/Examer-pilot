begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);
select ok(
    not has_function_privilege('anon', 'public.submit_answer_for_participant(uuid,uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.submit_answer_for_participant(uuid,uuid,uuid,jsonb)', 'execute')
    and has_function_privilege('service_role', 'public.submit_answer_for_participant(uuid,uuid,uuid,jsonb)', 'execute'),
    'Only the server role can execute answer submission'
);

select gen_random_uuid() as owner, gen_random_uuid() as other \gset
set local role service_role;
insert into public.evaluation_rounds (slug, title, status, questions_per_session)
values ('stage4-db-fixture', 'Synthetic batch', 'open', 3)
returning id as round \gset
insert into public.sessions (round_id, participant_id) values (:'round', :'owner') returning id as session \gset
insert into public.sessions (round_id, participant_id) values (:'round', :'other') returning id as foreign_session \gset

with logical as (
    insert into public.questions (external_id)
    values ('stage4-db-1'), ('stage4-db-2'), ('stage4-db-3') returning id, external_id
), versions as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    select id, 1,
        case external_id when 'stage4-db-1' then 'single_choice'
            when 'stage4-db-2' then 'multiple_choice' else 'true_false' end,
        'Synthetic statement',
        case external_id when 'stage4-db-3' then '[]'::jsonb
            else '[{"id":"B","text":"Beta"},{"id":"A","text":"Alpha"},{"id":"C","text":"Gamma"}]'::jsonb end,
        'published'
    from logical returning id, question_id
)
insert into public.round_questions (round_id, question_version_id, question_id)
select :'round', id, question_id from versions;

insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
select :'session', rq.id, rq.round_id, q.id, right(q.external_id, 1)::integer
from public.round_questions rq join public.questions q on q.id = rq.question_id where rq.round_id = :'round';
select id as a1 from public.session_questions where session_id = :'session' and position = 1 \gset
select id as a2 from public.session_questions where session_id = :'session' and position = 2 \gset
select id as a3 from public.session_questions where session_id = :'session' and position = 3 \gset

select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'other', :'session', :'a1', '"A"'),
    'PT404', 'SESSION_NOT_FOUND', 'A different user cannot answer in the session'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'other', :'foreign_session', :'a1', '"A"'),
    'PT404', 'ASSIGNMENT_NOT_FOUND', 'An assignment must belong to the named session'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a2', '["A"]'),
    'PT409', 'NOT_CURRENT_QUESTION', 'Skipping ahead is forbidden'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a1', '"unknown"'),
    'PT400', 'INVALID_ANSWER', 'Unknown single choice is rejected'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a1', '["A"]'),
    'PT400', 'INVALID_ANSWER', 'Single choice expects a JSON string'
);
select public.submit_answer_for_participant(:'owner', :'session', :'a1', '"A"')->>'response_id' as r1 \gset
select is((select selected_answer from public.responses where id = :'r1'), '"A"'::jsonb, 'Single choice is stored');
select is(
    public.get_current_question_for_participant(:'owner', :'session') - 'session' - 'question',
    jsonb_build_object('step','rating','response_id',:'r1'::uuid), 'Refresh restores the pending rating'
);
select is(
    public.submit_answer_for_participant(:'owner', :'session', :'a1', '"A"')->>'response_id',
    :'r1', 'The same answer returns the original response'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a1', '"B"'),
    'PT409', 'ANSWER_ALREADY_SUBMITTED', 'Another answer cannot overwrite the original'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a2', '["A"]'),
    'PT409', 'NOT_CURRENT_QUESTION', 'An unanswered rating still blocks the next assignment'
);
select is((select count(*) from public.ratings where response_id = :'r1'), 0::bigint, 'Answering does not create a rating');

insert into public.ratings (response_id, quality) values (:'r1', 'medium');
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a2', '["A",false]'),
    'PT400', 'INVALID_ANSWER', 'Nonstring items in a multiple-choice answer are rejected'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a2', '["unknown"]'),
    'PT400', 'INVALID_ANSWER', 'Unknown multiple-choice IDs are rejected'
);
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a2', '[]'),
    'PT400', 'INVALID_ANSWER', 'Multiple choice requires a nonempty selection'
);
select public.submit_answer_for_participant(:'owner', :'session', :'a2', '["A","B","A"]')->>'response_id' as r2 \gset
select is((select selected_answer from public.responses where id = :'r2'), '["B","A"]'::jsonb,
    'Multiple choice is deduplicated and stored in original option order');
select is(public.submit_answer_for_participant(:'owner', :'session', :'a2', '["B","A"]')->>'response_id',
    :'r2', 'Reordered and deduplicated equivalents are idempotent');

insert into public.ratings (response_id, quality) values (:'r2', 'medium');
update public.evaluation_rounds set status = 'closed' where id = :'round';
update public.round_questions set is_active = false where round_id = :'round';
update public.question_versions set review_status = 'retired'
where id in (select question_version_id from public.round_questions where round_id = :'round');
select throws_ok(
    format('select public.submit_answer_for_participant(%L,%L,%L,%L)', :'owner', :'session', :'a3', '"false"'),
    'PT400', 'INVALID_ANSWER', 'A JSON string is not a judgment answer'
);
select public.submit_answer_for_participant(:'owner', :'session', :'a3', 'false')->>'response_id' as r3 \gset
select is((select selected_answer from public.responses where id = :'r3'), 'false'::jsonb,
    'Boolean false is accepted even after closure and retirement');
select is((select count(*) from public.responses r join public.session_questions a on a.id = r.session_question_id
    where a.session_id = :'session'), 3::bigint, 'Exactly one response per assignment is kept');

reset role;
select * from finish();
rollback;
