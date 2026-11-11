begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(33);

select is(
  (select count(*) from pg_tables
    where schemaname = 'public' and rowsecurity and tablename in (
      'questions', 'question_versions', 'evaluation_rounds', 'round_questions',
      'sessions', 'session_questions', 'responses', 'ratings'
    )),
  8::bigint,
  'RLS is enabled on all eight business tables'
);

select ok(
  not exists (
    select from unnest(array['anon', 'authenticated']::name[]) as roles(role_name)
    cross join unnest(array[
      'public.questions', 'public.question_versions', 'public.evaluation_rounds',
      'public.round_questions', 'public.sessions', 'public.session_questions',
      'public.responses', 'public.ratings'
    ]::regclass[]) as business_tables(table_name)
    where has_table_privilege(
      role_name, table_name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    ) or has_any_column_privilege(role_name, table_name, 'SELECT, INSERT, UPDATE, REFERENCES')
  ),
  'Neither client role has direct table or column privileges on any business table'
);

select ok(
  not has_function_privilege('anon', 'public.preserve_published_question_version()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.preserve_published_question_version()', 'EXECUTE'),
  'Internal trigger functions are not exposed to client roles'
);

-- Use the same role that loads reviewed questions in a controlled environment.
set local role service_role;

insert into public.questions (id, external_id) values
  ('00000000-0000-4000-8000-000000000001', 'DB-TEST-SINGLE'),
  ('00000000-0000-4000-8000-000000000002', 'DB-TEST-TRUE-FALSE'),
  ('00000000-0000-4000-8000-000000000003', 'DB-TEST-MULTIPLE');

insert into public.question_versions (
  id, question_id, version_no, question_type, stem, options, review_status
) values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001',
   1, 'single_choice', 'Synthetic question v1', '[{"id":"A","text":"First"},{"id":"B","text":"Second"}]', 'published'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001',
   2, 'single_choice', 'Synthetic question v2', '[{"id":"A","text":"First"},{"id":"B","text":"Second"}]', 'published'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001',
   3, 'single_choice', 'Synthetic draft', '[{"id":"A","text":"First"},{"id":"B","text":"Second"}]', 'draft'),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000002',
   1, 'true_false', 'Synthetic true-false question', '[]', 'published'),
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000003',
   1, 'multiple_choice', 'Synthetic multiple-choice question', '[{"id":"A","text":"First"},{"id":"B","text":"Second"}]', 'published');

insert into public.evaluation_rounds (id, slug, title, description, status) values
  ('00000000-0000-4000-8000-000000000101', 'db-test-open', 'Open test round', 'Synthetic fixture', 'open'),
  ('00000000-0000-4000-8000-000000000102', 'db-test-draft', 'Draft test round', 'Synthetic fixture', 'draft');

insert into public.round_questions (id, round_id, question_version_id, question_id) values
  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000131', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-000000000102',
   '00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000002');

insert into public.sessions (id, round_id, participant_id) values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000901'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000902');

insert into public.session_questions (
  id, session_id, round_question_id, round_id, question_id, position
) values
  ('00000000-0000-4000-8000-000000000311', '00000000-0000-4000-8000-000000000301',
   '00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000001', 1),
  ('00000000-0000-4000-8000-000000000321', '00000000-0000-4000-8000-000000000301',
   '00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000002', 2),
  ('00000000-0000-4000-8000-000000000331', '00000000-0000-4000-8000-000000000301',
   '00000000-0000-4000-8000-000000000131', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000003', 3);

insert into public.responses (id, session_question_id, selected_answer) values
  ('00000000-0000-4000-8000-000000000411', '00000000-0000-4000-8000-000000000311', '"A"'),
  ('00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000321', 'true'),
  ('00000000-0000-4000-8000-000000000431', '00000000-0000-4000-8000-000000000331', '["A","B"]');

select throws_ok(
  $$insert into public.ratings (response_id, quality)
    values ('00000000-0000-4000-8000-000000000411', 'excellent')$$,
  '23514', null, 'An unrecognized quality level is rejected'
);

select throws_ok(
  $$insert into public.ratings (response_id, quality)
    values ('00000000-0000-4000-8000-000000000411', null)$$,
  '23502', null, 'A quality level is required'
);

insert into public.ratings (response_id, quality) values
  ('00000000-0000-4000-8000-000000000411', 'low'),
  ('00000000-0000-4000-8000-000000000421', 'medium'),
  ('00000000-0000-4000-8000-000000000431', 'high');

select throws_ok(
  $$insert into public.questions (external_id) values ('DB-TEST-SINGLE')$$,
  '23505', null, 'A stable external question ID is unique'
);

select throws_ok(
  $$insert into public.question_versions (question_id, version_no, question_type, stem, options)
    values ('00000000-0000-4000-8000-000000000001', 1, 'true_false', 'Replacement', '[]')$$,
  '23505', null, 'Reinserting the same question version fails'
);

select throws_ok(
  $$insert into public.question_versions (question_id, version_no, question_type, stem, options)
    values ('00000000-0000-4000-8000-000000000001', 0, 'true_false', 'Zero version', '[]')$$,
  '23514', null, 'Question versions must be positive'
);

select throws_ok(
  $$insert into public.question_versions (question_id, version_no, question_type, stem, options)
    values ('00000000-0000-4000-8000-000000000001', 4, 'essay', 'Unknown type', '[]')$$,
  '23514', null, 'Only supported question types are accepted'
);

select throws_ok(
  $$insert into public.question_versions (question_id, version_no, question_type, stem, options)
    values ('00000000-0000-4000-8000-000000000001', 4, 'true_false', 'Extra options', '[{"id":"A","text":"First"}]')$$,
  '23514', null, 'A true-false question cannot declare choices'
);

select throws_ok(
  $$update public.question_versions set stem = 'Changed'
    where id = '00000000-0000-4000-8000-000000000011'$$,
  '23514', null, 'The published stem cannot be changed'
);

select throws_ok(
  $$update public.question_versions set question_type = 'multiple_choice'
    where id = '00000000-0000-4000-8000-000000000011'$$,
  '23514', null, 'The published question type cannot be changed'
);

select throws_ok(
  $$update public.question_versions set options = '[{"id":"B","text":"Second"},{"id":"A","text":"First"}]'
    where id = '00000000-0000-4000-8000-000000000011'$$,
  '23514', null, 'The published options and their order cannot be changed'
);

select throws_ok(
  $$update public.question_versions set review_status = 'draft'
    where id = '00000000-0000-4000-8000-000000000011'$$,
  '23514', null, 'A published question cannot be put back into draft'
);

select throws_ok(
  $$update public.evaluation_rounds set status = 'open'
    where id = '00000000-0000-4000-8000-000000000102'$$,
  '23505', null, 'Only one round may be open'
);

select throws_ok(
  $$update public.evaluation_rounds set questions_per_session = 0
    where id = '00000000-0000-4000-8000-000000000101'$$,
  '23514', null, 'A round needs a positive session size'
);

select throws_ok(
  $$insert into public.round_questions (round_id, question_version_id, question_id)
    values ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000013',
            '00000000-0000-4000-8000-000000000001')$$,
  '23503', null, 'A draft question cannot be enabled for distribution'
);

select throws_ok(
  $$insert into public.round_questions (round_id, question_version_id, question_id)
    values ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000012',
            '00000000-0000-4000-8000-000000000001')$$,
  '23505', null, 'A round cannot enable two versions of one logical question'
);

select throws_ok(
  $$insert into public.sessions (round_id, participant_id)
    values ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000901')$$,
  '23505', null, 'A participant cannot have two first sets for the same round'
);

select throws_ok(
  $$update public.sessions set status = 'completed'
    where id = '00000000-0000-4000-8000-000000000301'$$,
  '23514', null, 'A completed session requires a completion timestamp'
);

select throws_ok(
  $$insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
    values ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000221',
            '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', 4)$$,
  '23503', null, 'A session cannot assign a round question from another round'
);

select throws_ok(
  $$insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
    values ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000221',
            '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 1)$$,
  '23503', null, 'Changing the round ID to match the question still cannot bypass the session round'
);

select throws_ok(
  $$insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
    values ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000121',
            '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 1)$$,
  '23503', null, 'An assignment must carry the real logical identity of its round question'
);

select throws_ok(
  $$insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
    values ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000121',
            '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002', 0)$$,
  '23514', null, 'The first valid assignment position is one'
);

select throws_ok(
  $$insert into public.responses (session_question_id, selected_answer)
    values ('00000000-0000-4000-8000-000000000311', '"B"')$$,
  '23505', null, 'A question assignment accepts at most one answer'
);

select throws_ok(
  $$insert into public.ratings (response_id, quality)
    values ('00000000-0000-4000-8000-000000000411', 'high')$$,
  '23505', null, 'An answer accepts at most one rating'
);

-- Swap the active version and retire the old one without changing old assignments.
update public.round_questions set is_active = false
where id = '00000000-0000-4000-8000-000000000111';

update public.question_versions set review_status = 'retired'
where id = '00000000-0000-4000-8000-000000000011';

insert into public.round_questions (id, round_id, question_version_id, question_id) values
  ('00000000-0000-4000-8000-000000000112', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001');

select throws_ok(
  $$insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
    values ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000112',
            '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 4)$$,
  '23505', null, 'A session cannot assign another version of an already assigned logical question'
);

select results_eq(
  $$select q.external_id, v.version_no, v.question_type::text, v.stem, v.options,
           res.selected_answer, rate.quality::text
    from public.sessions s
    join public.session_questions sq on sq.session_id = s.id
    join public.round_questions rq on rq.id = sq.round_question_id
    join public.question_versions v on v.id = rq.question_version_id
    join public.questions q on q.id = v.question_id
    join public.responses res on res.session_question_id = sq.id
    join public.ratings rate on rate.response_id = res.id
    where s.id = '00000000-0000-4000-8000-000000000301'
    order by sq.position$$,
  $$values
    ('DB-TEST-SINGLE', 1, 'single_choice', 'Synthetic question v1',
     '[{"id":"A","text":"First"},{"id":"B","text":"Second"}]'::jsonb, '"A"'::jsonb, 'low'),
    ('DB-TEST-TRUE-FALSE', 1, 'true_false', 'Synthetic true-false question', '[]'::jsonb, 'true'::jsonb, 'medium'),
    ('DB-TEST-MULTIPLE', 1, 'multiple_choice', 'Synthetic multiple-choice question',
     '[{"id":"A","text":"First"},{"id":"B","text":"Second"}]'::jsonb, '["A","B"]'::jsonb, 'high')$$,
  'The service role can load and read three reviewed types, their original answers, and all quality levels'
);

reset role;

select throws_ok(
  $$delete from public.question_versions where id = '00000000-0000-4000-8000-000000000011'$$,
  '23503', null, 'Even an administrator cannot delete a version referenced by historical work'
);

set local role anon;

select throws_ok(
  $$select stem, options from public.question_versions$$,
  '42501', null, 'The anon role cannot directly read question versions'
);

select throws_ok(
  $$insert into public.questions (external_id) values ('DB-TEST-UNAUTHORIZED')$$,
  '42501', null, 'The anon role cannot directly insert a question'
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000901';

select throws_ok(
  $$select id from public.sessions where participant_id = '00000000-0000-4000-8000-000000000901'$$,
  '42501', null, 'An authenticated participant cannot directly read even their own session'
);

select throws_ok(
  $$update public.ratings set quality = 'high'
    where response_id = '00000000-0000-4000-8000-000000000411'$$,
  '42501', null, 'An authenticated participant cannot directly update even their own rating'
);

reset role;

select * from finish();
rollback;
