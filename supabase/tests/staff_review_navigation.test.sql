begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);
select ok(
    not has_function_privilege('anon', 'public.browse_staff_review_questions(integer,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.browse_staff_review_questions(integer,text,text)', 'execute')
    and has_function_privilege('service_role', 'public.browse_staff_review_questions(integer,text,text)', 'execute'),
    'Only the server role can browse staff review questions'
);

insert into public.questions (external_id)
select 'staff-navigation-' || lpad(i::text, 2, '0') from generate_series(1, 16) as i;

insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
select id, 1, 'single_choice',
       'Synthetic navigation ' || case when external_id = 'staff-navigation-01' then 'staff-navigation-13' else external_id end,
       case when external_id = 'staff-navigation-13' then
          '[{"id":"A","text":"100%_ first"},{"id":"B","text":"100%_ second"}]'::jsonb
       else '[{"id":"A","text":"100xx"},{"id":"B","text":"Choice"}]'::jsonb end,
       case when external_id = 'staff-navigation-13' then 'draft' else 'published' end
from public.questions where external_id like 'staff-navigation-%';

insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
select id, 2, 'true_false', 'Retired synthetic version', '[]', 'retired'
from public.questions where external_id = 'staff-navigation-14';

insert into examerframe_private.question_review_notes (question_version_id, explanation)
select v.id, 'Draft note' from public.question_versions v join public.questions q on q.id = v.question_id
where q.external_id = 'staff-navigation-13';
insert into examerframe_private.question_feedback (question_version_id, standard_answer, explanation)
select v.id, '"B"', 'Published explanation' from public.question_versions v join public.questions q on q.id = v.question_id
where q.external_id = 'staff-navigation-15';
insert into examerframe_private.staff_question_ratings (question_version_id, quality)
select v.id, 'high' from public.question_versions v join public.questions q on q.id = v.question_id
where q.external_id = 'staff-navigation-15';

set local role service_role;

select public.browse_staff_review_questions() as first_page \gset
select is(jsonb_array_length(:'first_page'::jsonb -> 'questions'), 12,
    'The unfiltered first page includes twelve questions');
select is((:'first_page'::jsonb ->> 'total_count')::integer, 15,
    'The retired latest version removes that question from the count');

select public.browse_staff_review_questions(900) as last_page \gset
select ok(:'last_page'::jsonb ->> 'page' = '2' and :'last_page'::jsonb ->> 'total_pages' = '2'
    and :'last_page'::jsonb #>> '{questions,0,external_id}' = 'staff-navigation-13'
    and jsonb_array_length(:'last_page'::jsonb -> 'questions') = 3,
    'A page beyond the end returns the final unfiltered page');
select ok(:'last_page'::jsonb #>> '{questions,0,explanation}' = 'Draft note'
    and :'last_page'::jsonb #> '{questions,0,standard_answer}' = 'null'::jsonb
    and :'last_page'::jsonb #>> '{questions,1,explanation}' = 'Published explanation'
    and :'last_page'::jsonb #>> '{questions,1,standard_answer}' = 'B'
    and :'last_page'::jsonb #>> '{questions,1,quality}' = 'high',
    'Question cards show draft notes or the published feedback and staff rating');
select is(public.browse_staff_review_questions(1, null, 'staff-navigation-15'), :'last_page'::jsonb,
    'Locating a visible ID opens its page of ordinary question cards');
select throws_ok($$select public.browse_staff_review_questions(1, null, 'staff-navigation-14')$$,
    'PT404', 'QUESTION_NOT_FOUND', 'A retired latest version cannot be located');

select public.browse_staff_review_questions(1, E'\t100%_ ') as option_search \gset
select ok(:'option_search'::jsonb -> 'questions' = '[]'::jsonb
    and :'option_search'::jsonb -> 'matches' =
        '[{"external_id":"staff-navigation-13","stem":"Synthetic navigation staff-navigation-13","matched_option":"100%_ first"}]'::jsonb,
    'Option search treats % and _ literally and returns only a summary with the first matching option');
select is(public.browse_staff_review_questions(1, 'STAFF-NAVIGATION-13') #>> '{matches,0,external_id}',
    'staff-navigation-13', 'Exact ID matches rank above earlier IDs with matching stems');
select public.browse_staff_review_questions(2, 'sYnthetIC NAVIGATION') as stem_search \gset
select ok(:'stem_search'::jsonb ->> 'page' = '2'
    and :'stem_search'::jsonb ->> 'total_count' = '15'
    and jsonb_array_length(:'stem_search'::jsonb -> 'matches') = 3
    and :'stem_search'::jsonb #>> '{matches,1,external_id}' = 'staff-navigation-15',
    'Case-insensitive stem search paginates and omits retired questions');
select is(public.browse_staff_review_questions(17, 'unique phrase never used'),
    '{"page":1,"total_pages":0,"total_count":0,"questions":[],"matches":[]}'::jsonb,
    'An empty search returns empty arrays and a zero page count');
select throws_ok($$select public.browse_staff_review_questions(0)$$,
    'PT400', 'INVALID_STAFF_REVIEW_NAVIGATION', 'An invalid page is rejected');
select throws_ok($$select public.browse_staff_review_questions(1, 'phrase', 'staff-navigation-13')$$,
    'PT400', 'INVALID_STAFF_REVIEW_NAVIGATION', 'Search and location cannot be combined');

reset role;
select * from finish();
rollback;
