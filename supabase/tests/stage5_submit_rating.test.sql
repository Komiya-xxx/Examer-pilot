begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);
select ok(
    not has_function_privilege('anon', 'public.submit_rating_for_participant(uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.submit_rating_for_participant(uuid,uuid,text)', 'execute')
    and has_function_privilege('service_role', 'public.submit_rating_for_participant(uuid,uuid,text)', 'execute'),
    'Only the server role can execute rating submission'
);
select ok(
    not has_function_privilege('anon', 'public.get_active_round_for_participant(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.get_active_round_for_participant(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.get_active_round_for_participant(uuid)', 'execute'),
    'The replaced round lookup keeps server-only execution'
);

select gen_random_uuid() as owner, gen_random_uuid() as other \gset
set local role service_role;
insert into public.evaluation_rounds (slug, title, status, questions_per_session, starts_at, ends_at)
values ('stage5-db-fixture', 'Synthetic rating batch', 'open', 2, now() - interval '1 hour', now() + interval '1 hour')
returning id as round \gset
insert into public.sessions (round_id, participant_id, started_at)
values (:'round', :'owner', now() - interval '1 day') returning id as session \gset
insert into public.sessions (round_id, participant_id) values (:'round', :'other') returning id as foreign_session \gset

with logical as (
    insert into public.questions (external_id)
    values ('stage5-db-1'), ('stage5-db-2') returning id, external_id
), versions as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    select id, 1, 'single_choice', 'Synthetic statement',
        '[{"id":"A","text":"Alpha"},{"id":"B","text":"Beta"}]'::jsonb, 'published'
    from logical returning id, question_id
)
insert into public.round_questions (round_id, question_version_id, question_id)
select :'round', id, question_id from versions;

insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
select :'session', rq.id, rq.round_id, rq.question_id, right(q.external_id, 1)::integer
from public.round_questions rq join public.questions q on q.id = rq.question_id where rq.round_id = :'round';
select id as a1 from public.session_questions where session_id = :'session' and position = 1 \gset
select id as a2 from public.session_questions where session_id = :'session' and position = 2 \gset
select public.submit_answer_for_participant(:'owner', :'session', :'a1', '"A"')->>'response_id' as r1 \gset
insert into public.responses (session_question_id, selected_answer) values (:'a2', '"B"') returning id as r2 \gset

select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'other', :'r1', 'high'),
    'PT404', 'RESPONSE_NOT_FOUND', 'A different user cannot rate a response'
);
select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'owner', gen_random_uuid(), 'high'),
    'PT404', 'RESPONSE_NOT_FOUND', 'An unknown response is not found'
);
select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'owner', :'r1', 'excellent'),
    'PT400', 'INVALID_QUALITY', 'An unknown quality is rejected'
);
select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'owner', :'r1', 'HIGH'),
    'PT400', 'INVALID_QUALITY', 'Quality is matched exactly'
);
select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'owner', :'r1', null),
    'PT400', 'INVALID_QUALITY', 'A null quality is rejected'
);
select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'owner', :'r2', 'low'),
    'PT409', 'NOT_CURRENT_QUESTION', 'An unrated earlier question blocks a later rating'
);

select is(
    public.submit_rating_for_participant(:'owner', :'r1', 'high')->'session',
    jsonb_build_object('id', :'session'::uuid, 'round_id', :'round'::uuid,
        'status', 'in_progress', 'assigned_count', 2, 'rated_count', 1),
    'An intermediate rating returns the current session summary'
);
select is(
    public.submit_rating_for_participant(:'owner', :'r1', 'high')->>'rating_id',
    (select id::text from public.ratings where response_id = :'r1'),
    'The same rating replays the original ID'
);
select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'owner', :'r1', 'low'),
    'PT409', 'RATING_ALREADY_SUBMITTED', 'Another rating cannot overwrite the original'
);
select is(
    public.get_current_question_for_participant(:'owner', :'session')->>'response_id',
    :'r2', 'After the earlier rating, the next answered question becomes eligible'
);

select is(
    public.submit_rating_for_participant(:'owner', :'r2', 'medium')->'session',
    jsonb_build_object('id', :'session'::uuid, 'round_id', :'round'::uuid,
        'status', 'completed', 'assigned_count', 2, 'rated_count', 2),
    'The last rating completes the session atomically'
);
select ok(
    (select status = 'completed' and completed_at is not null from public.sessions where id = :'session'),
    'Completion leaves a consistent status and completion time'
);
select is(
    public.get_active_round_for_participant(:'owner') #>> '{session,status}',
    'completed', 'A refresh after completion still shows the finished session'
);
select throws_ok(
    format('select public.submit_rating_for_participant(%L,%L,%L)', :'owner', :'r2', 'high'),
    'PT409', 'RATING_ALREADY_SUBMITTED', 'A completed session keeps its ratings immutable'
);
select is(
    (select count(*) from public.ratings t join public.responses r on r.id = t.response_id
        join public.session_questions a on a.id = r.session_question_id
        where a.session_id = :'session'),
    2::bigint, 'Exactly one rating exists per answered assignment'
);

update public.evaluation_rounds set status = 'closed' where id = :'round';
select is(
    public.get_active_round_for_participant(:'owner') #>> '{session,status}',
    'completed', 'A closed round still surfaces the finished session for the owner'
);

reset role;
select * from finish();
rollback;
