begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(34);
select ok((select relrowsecurity from pg_class
    where oid = 'examerframe_private.staff_question_ratings'::regclass),
    'Staff ratings have row-level security enabled');
select ok(
    not has_function_privilege('anon', 'public.list_staff_review_questions(text)', 'execute')
    and not has_function_privilege('anon', 'public.save_staff_question_rating(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_staff_review_questions(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.save_staff_question_rating(uuid,text)', 'execute')
    and has_function_privilege('service_role', 'public.list_staff_review_questions(text)', 'execute')
    and has_function_privilege('service_role', 'public.save_staff_question_rating(uuid,text)', 'execute'),
    'Staff review operations are limited to the trusted server role'
);
select ok(
    not has_table_privilege('anon', 'examerframe_private.staff_question_ratings', 'select')
    and not has_table_privilege('authenticated', 'examerframe_private.staff_question_ratings', 'select')
    and not has_table_privilege('authenticated', 'examerframe_private.staff_question_ratings', 'insert')
    and has_table_privilege('service_role', 'examerframe_private.staff_question_ratings', 'select')
    and has_table_privilege('service_role', 'examerframe_private.staff_question_ratings', 'insert')
    and has_table_privilege('service_role', 'examerframe_private.staff_question_ratings', 'update'),
    'Private staff ratings are readable and writable only by the trusted server role'
);

insert into public.evaluation_rounds (slug, title, status, questions_per_session)
values ('staff-review-fixture', 'Synthetic staff review batch', 'open', 3)
returning id as round \gset

with logical as (
    insert into public.questions (external_id)
    select 'staff-review-' || lpad(n::text, 2, '0') from generate_series(1, 14) as n
    returning id, external_id
), versions as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    select id, 1, 'true_false', 'Synthetic statement ' || right(external_id, 2), '[]'::jsonb, 'published'
    from logical returning id, question_id
)
insert into public.round_questions (round_id, question_version_id, question_id)
select :'round', v.id, v.question_id
from versions v join logical q on q.id = v.question_id
where q.external_id <> 'staff-review-02';

insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
select v.id, 'true'::jsonb, 'Synthetic explanation ' || q.external_id
from public.question_versions v join public.questions q on q.id = v.question_id
where v.version_no = 1 and q.external_id like 'staff-review-%'
  and q.external_id not in ('staff-review-01', 'staff-review-02');

with revised as (
    insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
    select id, 2, 'true_false', 'Synthetic draft revision', '[]'::jsonb, 'draft'
    from public.questions where external_id = 'staff-review-01'
    returning id, question_id
)
insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
select id, 'false'::jsonb, 'Synthetic draft explanation' from revised
returning question_version_id as v2 \gset

select v.id as v1 from public.question_versions v join public.questions q on q.id = v.question_id
where q.external_id = 'staff-review-01' and v.version_no = 1 \gset

set local role service_role;
select public.list_staff_review_questions() as first \gset
select is(jsonb_array_length(:'first'::jsonb -> 'questions'), 12,
    'The first page is capped at twelve questions');
select is(:'first'::jsonb ->> 'next_cursor', 'staff-review-12',
    'A full page returns the last delivered id as its cursor');
select is(
    (select jsonb_agg(item ->> 'external_id' order by ord)
        from jsonb_array_elements(:'first'::jsonb -> 'questions') with ordinality as t(item, ord)),
    (select jsonb_agg('staff-review-' || lpad(n::text, 2, '0') order by n) from generate_series(1, 12) as n),
    'Every question is listed by external id, including one outside any round'
);
select is(:'first'::jsonb #>> '{questions,0,version_no}', '2',
    'The latest version is selected even when it is a draft');
select is(:'first'::jsonb #>> '{questions,0,stem}', 'Synthetic draft revision',
    'The latest draft revision supplies the stem');
select is(:'first'::jsonb #> '{questions,0,standard_answer}', 'false'::jsonb,
    'The exact latest version supplies its private answer');
select is(:'first'::jsonb #>> '{questions,0,explanation}', 'Synthetic draft explanation',
    'The exact latest version supplies its private explanation');
select is(:'first'::jsonb #>> '{questions,2,explanation}', 'Synthetic explanation staff-review-03',
    'A published version supplies its own private explanation');
select ok(
    (:'first'::jsonb #> '{questions,1,standard_answer}') = 'null'::jsonb
    and (:'first'::jsonb #> '{questions,1,explanation}') = 'null'::jsonb,
    'A question without feedback returns null private fields'
);
select is(:'first'::jsonb #> '{questions,0,quality}', 'null'::jsonb,
    'An unrated question reports no quality');

select is(public.save_staff_question_rating(:'v2', 'high') ->> 'quality', 'high',
    'A staff rating can be saved without any student work');
select is(public.list_staff_review_questions() #>> '{questions,0,quality}', 'high',
    'Reloading the list returns the saved rating for the latest version');
select is(public.save_staff_question_rating(:'v1', 'low') ->> 'quality', 'low',
    'An older version can be rated independently');
select is(public.list_staff_review_questions() #>> '{questions,0,quality}', 'high',
    'Rating an older version does not change the latest version');
select is((select count(*) from examerframe_private.staff_question_ratings
    where question_version_id in (:'v1', :'v2')), 2::bigint,
    'Each version keeps its own single rating row');
select is(public.save_staff_question_rating(:'v2', 'medium') ->> 'quality', 'medium',
    'An existing rating can be replaced');
select is(public.list_staff_review_questions() #>> '{questions,0,quality}', 'medium',
    'The replacement is visible on reload');
select is((select count(*) from examerframe_private.staff_question_ratings
    where question_version_id = :'v2'), 1::bigint,
    'Replacing a rating does not duplicate its row');
select is((select count(*) from public.sessions where round_id = :'round'), 0::bigint,
    'Saving a staff rating requires no student session');

select public.list_staff_review_questions('staff-review-12') as second \gset
select is(jsonb_array_length(:'second'::jsonb -> 'questions'), 2,
    'The remaining questions follow the cursor');
select is(:'second'::jsonb -> 'next_cursor', 'null'::jsonb,
    'The final page has no next cursor');
select is(:'second'::jsonb #>> '{questions,0,external_id}', 'staff-review-13',
    'The cursor page resumes at the next external id');

select throws_ok(format('select public.save_staff_question_rating(%L,%L)', :'v2', 'excellent'),
    'PT400', 'INVALID_QUALITY', 'An unknown quality is rejected');
select throws_ok(format('select public.save_staff_question_rating(%L, null)', :'v2'),
    'PT400', 'INVALID_QUALITY', 'A missing quality is rejected');
select throws_ok(format('select public.save_staff_question_rating(%L,%L)', gen_random_uuid(), 'high'),
    'PT404', 'QUESTION_VERSION_NOT_FOUND', 'An unknown version is rejected');

set local role anon;
select throws_ok($$select public.list_staff_review_questions()$$,
    '42501', null, 'The anon role cannot call the staff review list');
select throws_ok(format('select public.save_staff_question_rating(%L,%L)', :'v2', 'high'),
    '42501', null, 'The anon role cannot save a staff rating');
select throws_ok($$select quality from examerframe_private.staff_question_ratings$$,
    '42501', null, 'The anon role cannot read private staff ratings');

set local role authenticated;
select throws_ok($$select public.list_staff_review_questions()$$,
    '42501', null, 'An authenticated user cannot call the staff review list');
select throws_ok(format('select public.save_staff_question_rating(%L,%L)', :'v2', 'high'),
    '42501', null, 'An authenticated user cannot save a staff rating');
select throws_ok($$select quality from examerframe_private.staff_question_ratings$$,
    '42501', null, 'An authenticated user cannot read private staff ratings');

reset role;
select * from finish();
rollback;
