begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

\set p_a '30000000-0000-4000-8000-0000000000a1'
\set p_b '30000000-0000-4000-8000-0000000000a2'
\set p_c '30000000-0000-4000-8000-0000000000a3'
\set p_d '30000000-0000-4000-8000-0000000000a4'
\set p_e '30000000-0000-4000-8000-0000000000a5'
\set p_w '30000000-0000-4000-8000-0000000000a6'
\set p_h1 '30000000-0000-4000-8000-0000000000b1'
\set p_h2 '30000000-0000-4000-8000-0000000000b2'
\set p_h3 '30000000-0000-4000-8000-0000000000b3'
\set p_h4 '30000000-0000-4000-8000-0000000000b4'

\set r_main '30000000-0000-4000-8000-000000000101'
\set r_closed '30000000-0000-4000-8000-000000000102'
\set r_small '30000000-0000-4000-8000-000000000103'
\set r_other '30000000-0000-4000-8000-000000000104'

\set s_b '30000000-0000-4000-8000-000000000201'
\set s_c '30000000-0000-4000-8000-000000000202'
\set s_d '30000000-0000-4000-8000-000000000203'
\set s_h1 '30000000-0000-4000-8000-000000000211'
\set s_h2 '30000000-0000-4000-8000-000000000212'
\set s_h3 '30000000-0000-4000-8000-000000000213'
\set s_h4 '30000000-0000-4000-8000-000000000214'

\set q1 '30000000-0000-4000-8000-000000000301'
\set q2 '30000000-0000-4000-8000-000000000302'
\set q3 '30000000-0000-4000-8000-000000000303'
\set q4 '30000000-0000-4000-8000-000000000304'
\set q5 '30000000-0000-4000-8000-000000000305'
\set q6 '30000000-0000-4000-8000-000000000306'
\set q10 '30000000-0000-4000-8000-000000000401'
\set q11 '30000000-0000-4000-8000-000000000402'
\set q12 '30000000-0000-4000-8000-000000000403'
\set q13 '30000000-0000-4000-8000-000000000404'
\set q14 '30000000-0000-4000-8000-000000000405'
\set q20 '30000000-0000-4000-8000-000000000501'
\set q21 '30000000-0000-4000-8000-000000000502'
\set q22 '30000000-0000-4000-8000-000000000503'

\set v1 '30000000-0000-4000-8000-000000000311'
\set v2 '30000000-0000-4000-8000-000000000312'
\set v3 '30000000-0000-4000-8000-000000000313'
\set v4 '30000000-0000-4000-8000-000000000314'
\set v5 '30000000-0000-4000-8000-000000000315'
\set v6 '30000000-0000-4000-8000-000000000316'
\set v1b '30000000-0000-4000-8000-000000000321'
\set v10 '30000000-0000-4000-8000-000000000411'
\set v11 '30000000-0000-4000-8000-000000000412'
\set v12 '30000000-0000-4000-8000-000000000413'
\set v13 '30000000-0000-4000-8000-000000000414'
\set v14 '30000000-0000-4000-8000-000000000415'
\set v20 '30000000-0000-4000-8000-000000000511'
\set v21 '30000000-0000-4000-8000-000000000512'
\set v22 '30000000-0000-4000-8000-000000000513'

\set a1 '30000000-0000-4000-8000-000000001101'
\set a2 '30000000-0000-4000-8000-000000001102'
\set a3 '30000000-0000-4000-8000-000000001103'
\set a4 '30000000-0000-4000-8000-000000001104'
\set a5 '30000000-0000-4000-8000-000000001105'
\set a1_disabled '30000000-0000-4000-8000-000000001106'
\set a6 '30000000-0000-4000-8000-000000001107'
\set a10 '30000000-0000-4000-8000-000000001201'
\set a11 '30000000-0000-4000-8000-000000001202'
\set a12 '30000000-0000-4000-8000-000000001203'
\set a13 '30000000-0000-4000-8000-000000001204'
\set a14 '30000000-0000-4000-8000-000000001205'
\set a20 '30000000-0000-4000-8000-000000001301'
\set a21 '30000000-0000-4000-8000-000000001302'
\set a22 '30000000-0000-4000-8000-000000001303'

\set sq_b1 '30000000-0000-4000-8000-000000002101'
\set sq_b2 '30000000-0000-4000-8000-000000002102'
\set sq_b3 '30000000-0000-4000-8000-000000002103'
\set sq_c1 '30000000-0000-4000-8000-000000002111'
\set sq_d1 '30000000-0000-4000-8000-000000002121'
\set sq_h11 '30000000-0000-4000-8000-000000002201'
\set sq_h21 '30000000-0000-4000-8000-000000002211'
\set sq_h22 '30000000-0000-4000-8000-000000002212'
\set sq_h31 '30000000-0000-4000-8000-000000002221'
\set sq_h32 '30000000-0000-4000-8000-000000002222'
\set sq_h33 '30000000-0000-4000-8000-000000002223'
\set sq_h41 '30000000-0000-4000-8000-000000002231'
\set sq_h42 '30000000-0000-4000-8000-000000002232'
\set sq_h43 '30000000-0000-4000-8000-000000002233'
\set sq_h44 '30000000-0000-4000-8000-000000002234'

\set resp_b1 '30000000-0000-4000-8000-000000003101'
\set resp_b2 '30000000-0000-4000-8000-000000003102'
\set resp_d1 '30000000-0000-4000-8000-000000003103'

-- Privileges: the stage 3 RPCs are service-role only.

select ok(
    not exists (
        select 1
        from pg_proc as procedure
        cross join lateral aclexplode(
            coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) as privilege
        where procedure.oid in (
            'public.start_or_resume_session_for_participant(uuid, uuid)'::regprocedure,
            'public.get_current_question_for_participant(uuid, uuid)'::regprocedure
        )
          and privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
    ),
    'Neither stage 3 RPC has default PUBLIC execute permission'
);

select ok(
    not has_function_privilege(
        'anon',
        'public.start_or_resume_session_for_participant(uuid, uuid)',
        'EXECUTE'
    )
    and not has_function_privilege(
        'authenticated',
        'public.start_or_resume_session_for_participant(uuid, uuid)',
        'EXECUTE'
    )
    and not has_function_privilege(
        'anon',
        'public.get_current_question_for_participant(uuid, uuid)',
        'EXECUTE'
    )
    and not has_function_privilege(
        'authenticated',
        'public.get_current_question_for_participant(uuid, uuid)',
        'EXECUTE'
    ),
    'Client roles cannot execute either stage 3 RPC'
);

select ok(
    has_function_privilege(
        'service_role',
        'public.start_or_resume_session_for_participant(uuid, uuid)',
        'EXECUTE'
    )
    and has_function_privilege(
        'service_role',
        'public.get_current_question_for_participant(uuid, uuid)',
        'EXECUTE'
    ),
    'The service role can execute both stage 3 RPCs'
);

set local role anon;

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_a',
        :'r_main'
    ),
    '42501', null, 'The anon role cannot start a session'
);

select throws_ok(
    format(
        'select public.get_current_question_for_participant(%L, %L)',
        :'p_a',
        :'s_b'
    ),
    '42501', null, 'The anon role cannot read the current question'
);

reset role;
set local role authenticated;

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_a',
        :'r_main'
    ),
    '42501', null, 'The authenticated role cannot start a session'
);

select throws_ok(
    format(
        'select public.get_current_question_for_participant(%L, %L)',
        :'p_a',
        :'s_b'
    ),
    '42501', null, 'The authenticated role cannot read the current question'
);

reset role;
set local role service_role;

-- Fixtures. The main round has five eligible active candidates whose actual
-- assignment counts are 4, 3, 2, 1, and 0. A sixth logical question only exists
-- in another round, and an inactive second version of question 1 must never be
-- sampled.

insert into public.evaluation_rounds (
    id, slug, title, description, status, questions_per_session, starts_at, ends_at
) values
    (:'r_main', 'stage3-db-main', 'Stage 3 main round', '', 'open', 3,
     now() - interval '1 hour', now() + interval '1 hour'),
    (:'r_closed', 'stage3-db-closed', 'Stage 3 closed round', '', 'closed', 3,
     null, null),
    (:'r_small', 'stage3-db-small', 'Stage 3 small pool round', '', 'closed', 3,
     null, null),
    (:'r_other', 'stage3-db-other', 'Stage 3 other round', '', 'closed', 1,
     null, null);

insert into public.questions (id, external_id) values
    (:'q1', 'STAGE3-MAIN-1'),
    (:'q2', 'STAGE3-MAIN-2'),
    (:'q3', 'STAGE3-MAIN-3'),
    (:'q4', 'STAGE3-MAIN-4'),
    (:'q5', 'STAGE3-MAIN-5'),
    (:'q6', 'STAGE3-MAIN-6'),
    (:'q10', 'STAGE3-CLOSED-10'),
    (:'q11', 'STAGE3-CLOSED-11'),
    (:'q12', 'STAGE3-CLOSED-12'),
    (:'q13', 'STAGE3-CLOSED-13'),
    (:'q14', 'STAGE3-CLOSED-14'),
    (:'q20', 'STAGE3-SMALL-20'),
    (:'q21', 'STAGE3-SMALL-21'),
    (:'q22', 'STAGE3-SMALL-22');

insert into public.question_versions (
    id, question_id, version_no, question_type, stem, options, review_status
) values
    (:'v1', :'q1', 1, 'single_choice', 'Stage 3 main question 1',
     '[{"id":"A","text":"A"},{"id":"B","text":"B"}]', 'published'),
    (:'v2', :'q2', 1, 'single_choice', 'Stage 3 main question 2',
     '[{"id":"A","text":"A"},{"id":"B","text":"B"}]', 'published'),
    (:'v3', :'q3', 1, 'single_choice', 'Stage 3 main question 3',
     '[{"id":"A","text":"A"},{"id":"B","text":"B"}]', 'published'),
    (:'v4', :'q4', 1, 'single_choice', 'Stage 3 main question 4',
     '[{"id":"A","text":"A"},{"id":"B","text":"B"}]', 'published'),
    (:'v5', :'q5', 1, 'single_choice', 'Stage 3 main question 5',
     '[{"id":"A","text":"A"},{"id":"B","text":"B"}]', 'published'),
    (:'v6', :'q6', 1, 'true_false', 'Stage 3 other round question', '[]',
     'published'),
    (:'v1b', :'q1', 2, 'single_choice', 'Stage 3 main question 1 newer',
     '[{"id":"A","text":"A"},{"id":"B","text":"B"}]', 'published'),
    (:'v10', :'q10', 1, 'single_choice', 'Stage 3 closed single choice',
     '[{"id":"A","text":"Alpha","secret":"hidden"},{"id":"B","text":"Beta"}]',
     'published'),
    (:'v11', :'q11', 1, 'multiple_choice', 'Stage 3 closed multiple choice',
     '[{"id":"A","text":"Alpha"},{"id":"B","text":"Beta","hint":"hidden"},{"id":"C","text":"Gamma"}]',
     'published'),
    (:'v12', :'q12', 1, 'true_false', 'Stage 3 closed true false one', '[]',
     'published'),
    (:'v13', :'q13', 1, 'true_false', 'Stage 3 closed true false two', '[]',
     'published'),
    (:'v14', :'q14', 1, 'single_choice', 'Stage 3 closed completed question',
     '[{"id":"A","text":"Alpha"},{"id":"B","text":"Beta"}]', 'published'),
    (:'v20', :'q20', 1, 'true_false', 'Stage 3 small pool question 20', '[]',
     'published'),
    (:'v21', :'q21', 1, 'true_false', 'Stage 3 small pool question 21', '[]',
     'published'),
    (:'v22', :'q22', 1, 'true_false', 'Stage 3 small pool question 22', '[]',
     'published');

insert into public.round_questions (
    id, round_id, question_version_id, question_id, is_active
) values
    (:'a1', :'r_main', :'v1', :'q1', true),
    (:'a2', :'r_main', :'v2', :'q2', true),
    (:'a3', :'r_main', :'v3', :'q3', true),
    (:'a4', :'r_main', :'v4', :'q4', true),
    (:'a5', :'r_main', :'v5', :'q5', true),
    (:'a1_disabled', :'r_main', :'v1b', :'q1', false),
    (:'a6', :'r_other', :'v6', :'q6', true),
    (:'a10', :'r_closed', :'v10', :'q10', true),
    (:'a11', :'r_closed', :'v11', :'q11', true),
    (:'a12', :'r_closed', :'v12', :'q12', true),
    (:'a13', :'r_closed', :'v13', :'q13', true),
    (:'a14', :'r_closed', :'v14', :'q14', true),
    (:'a20', :'r_small', :'v20', :'q20', true),
    (:'a21', :'r_small', :'v21', :'q21', true),
    (:'a22', :'r_small', :'v22', :'q22', false);

insert into public.sessions (
    id, round_id, participant_id, status, started_at, completed_at
) values
    (:'s_h1', :'r_main', :'p_h1', 'in_progress', now() - interval '5 hours', null),
    (:'s_h2', :'r_main', :'p_h2', 'in_progress', now() - interval '4 hours', null),
    (:'s_h3', :'r_main', :'p_h3', 'in_progress', now() - interval '3 hours', null),
    (:'s_h4', :'r_main', :'p_h4', 'in_progress', now() - interval '2 hours', null),
    (:'s_b', :'r_closed', :'p_b', 'in_progress', now() - interval '2 hours', null),
    (:'s_c', :'r_closed', :'p_c', 'in_progress', now() - interval '2 hours', null),
    (:'s_d', :'r_closed', :'p_d', 'completed', now() - interval '3 hours',
     now() - interval '2 hours');

insert into public.session_questions (
    id, session_id, round_question_id, round_id, question_id, position
) values
    (:'sq_h11', :'s_h1', :'a1', :'r_main', :'q1', 1),
    (:'sq_h21', :'s_h2', :'a1', :'r_main', :'q1', 1),
    (:'sq_h22', :'s_h2', :'a2', :'r_main', :'q2', 2),
    (:'sq_h31', :'s_h3', :'a1', :'r_main', :'q1', 1),
    (:'sq_h32', :'s_h3', :'a2', :'r_main', :'q2', 2),
    (:'sq_h33', :'s_h3', :'a3', :'r_main', :'q3', 3),
    (:'sq_h41', :'s_h4', :'a1', :'r_main', :'q1', 1),
    (:'sq_h42', :'s_h4', :'a2', :'r_main', :'q2', 2),
    (:'sq_h43', :'s_h4', :'a3', :'r_main', :'q3', 3),
    (:'sq_h44', :'s_h4', :'a4', :'r_main', :'q4', 4),
    (:'sq_b1', :'s_b', :'a10', :'r_closed', :'q10', 1),
    (:'sq_b2', :'s_b', :'a11', :'r_closed', :'q11', 2),
    (:'sq_b3', :'s_b', :'a12', :'r_closed', :'q12', 3),
    (:'sq_c1', :'s_c', :'a13', :'r_closed', :'q13', 1),
    (:'sq_d1', :'s_d', :'a14', :'r_closed', :'q14', 1);

insert into public.responses (id, session_question_id, selected_answer) values
    (:'resp_b1', :'sq_b1', '"A"'),
    (:'resp_b2', :'sq_b2', '["A","B"]'),
    (:'resp_d1', :'sq_d1', '"B"');

insert into public.ratings (response_id, quality) values
    (:'resp_b1', 'low'),
    (:'resp_d1', 'high');

-- New session distribution.

-- Capture the one-shot start payload first: later assertions read the rows it
-- created, so the call must not share a statement with those reads.
create temp table stage3_first_start as
select public.start_or_resume_session_for_participant(:'p_a', :'r_main') as body;

select is(
    (select body from stage3_first_start),
    (
        select jsonb_build_object(
            'session', jsonb_build_object(
                'id', session.id,
                'round_id', session.round_id,
                'status', session.status,
                'assigned_count', 3,
                'rated_count', 0
            )
        )
        from public.sessions as session
        where session.participant_id = :'p_a'
          and session.round_id = :'r_main'
    ),
    'Starting a session returns the shared session payload with its progress'
);

select results_eq(
    format(
        $$select assignment.round_question_id, assignment.position
          from public.session_questions as assignment
          where assignment.session_id = (
              select session.id
              from public.sessions as session
              where session.participant_id = %L
                and session.round_id = %L
          )
          order by assignment.position$$,
        :'p_a',
        :'r_main'
    ),
    format(
        $$values (%L::uuid, 1), (%L::uuid, 2), (%L::uuid, 3)$$,
        :'a5',
        :'a4',
        :'a3'
    ),
    'The three least-assigned candidates are fixed in ascending count order'
);

select ok(
    (
        select count(*) = count(distinct assignment.question_id)
        from public.session_questions as assignment
        where assignment.session_id = (
            select session.id
            from public.sessions as session
            where session.participant_id = :'p_a'
              and session.round_id = :'r_main'
        )
    ),
    'A session never assigns the same logical question twice'
);

select ok(
    not exists (
        select 1
        from public.session_questions as assignment
        where assignment.session_id = (
            select session.id
            from public.sessions as session
            where session.participant_id = :'p_a'
              and session.round_id = :'r_main'
        )
          and assignment.round_question_id in (:'a1_disabled', :'a6')
    ),
    'Disabled and other-round associations are excluded from the fixed list'
);

select is(
    public.start_or_resume_session_for_participant(:'p_a', :'r_main'),
    (select body from stage3_first_start),
    'A repeated start returns the initial payload without changing the session'
);

select ok(
    (
        select count(*)
        from public.sessions
        where participant_id = :'p_a'
          and round_id = :'r_main'
    ) = 1
    and (
        select count(*)
        from public.session_questions as assignment
        where assignment.session_id = (
            select session.id
            from public.sessions as session
            where session.participant_id = :'p_a'
              and session.round_id = :'r_main'
        )
    ) = 3,
    'A repeated start leaves one session and its original three assignments'
);

-- Current question projection. Session B has a rated first assignment, so the
-- second assignment is the pending rating; options lose any extra metadata.

select is(
    public.get_current_question_for_participant(:'p_b', :'s_b'),
    jsonb_build_object(
        'session', jsonb_build_object(
            'id', :'s_b'::uuid,
            'round_id', :'r_closed'::uuid,
            'status', 'in_progress',
            'assigned_count', 3,
            'rated_count', 1
        ),
        'step', 'rating',
        'question', jsonb_build_object(
            'assignment_id', :'sq_b2'::uuid,
            'position', 2,
            'question_type', 'multiple_choice',
            'stem', 'Stage 3 closed multiple choice',
            'options', '[{"id":"A","text":"Alpha"},{"id":"B","text":"Beta"},{"id":"C","text":"Gamma"}]'::jsonb
        ),
        'response_id', :'resp_b2'::uuid
    ),
    'The pending rating exposes only the whitelisted public question fields'
);

select is(
    public.get_current_question_for_participant(:'p_c', :'s_c'),
    jsonb_build_object(
        'session', jsonb_build_object(
            'id', :'s_c'::uuid,
            'round_id', :'r_closed'::uuid,
            'status', 'in_progress',
            'assigned_count', 1,
            'rated_count', 0
        ),
        'step', 'answer',
        'question', jsonb_build_object(
            'assignment_id', :'sq_c1'::uuid,
            'position', 1,
            'question_type', 'true_false',
            'stem', 'Stage 3 closed true false two',
            'options', '[]'::jsonb
        ),
        'response_id', null
    ),
    'An unanswered true-false question is returned with an empty option list'
);

select is(
    public.get_current_question_for_participant(:'p_d', :'s_d'),
    jsonb_build_object(
        'session', jsonb_build_object(
            'id', :'s_d'::uuid,
            'round_id', :'r_closed'::uuid,
            'status', 'completed',
            'assigned_count', 1,
            'rated_count', 1
        ),
        'step', 'completed',
        'question', null,
        'response_id', null
    ),
    'A completed session has no remaining question or response'
);

-- Time window and round eligibility for a new session.

update public.evaluation_rounds
set starts_at = now() + interval '30 minutes'
where id = :'r_main';

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_w',
        :'r_main'
    ),
    'PT409', 'ROUND_NOT_OPEN',
    'A future start boundary rejects a new session'
);

update public.evaluation_rounds
set starts_at = now() - interval '1 hour', ends_at = now()
where id = :'r_main';

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_w',
        :'r_main'
    ),
    'PT409', 'ROUND_NOT_OPEN',
    'The end boundary is exclusive for a new session'
);

update public.evaluation_rounds
set starts_at = null, ends_at = null, status = 'closed'
where id = :'r_main';

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_w',
        :'r_main'
    ),
    'PT409', 'ROUND_NOT_OPEN',
    'A closed round rejects a new session'
);

update public.evaluation_rounds
set status = 'draft'
where id = :'r_main';

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_w',
        :'r_main'
    ),
    'PT409', 'ROUND_NOT_OPEN',
    'A draft round rejects a new session'
);

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_w',
        '30000000-0000-4000-8000-0000000001ff'
    ),
    'PT409', 'ROUND_NOT_OPEN',
    'A missing round reports the same not-open error'
);

select is(
    (
        select count(*)
        from public.sessions
        where participant_id = :'p_w'
          and round_id = :'r_main'
    ),
    0::bigint,
    'Rejected starts create no session'
);

update public.evaluation_rounds
set status = 'open', starts_at = now(), ends_at = now() + interval '1 hour'
where id = :'r_main';

create temp table stage3_window_start as
select public.start_or_resume_session_for_participant(:'p_w', :'r_main') as body;

select ok(
    (select body #>> '{session,status}' from stage3_window_start) = 'in_progress'
    and (select body #>> '{session,assigned_count}' from stage3_window_start) = '3'
    and (
        select count(*)
        from public.sessions
        where participant_id = :'p_w'
          and round_id = :'r_main'
    ) = 1
    and (
        select count(*)
        from public.session_questions as assignment
        where assignment.session_id = (
            select session.id
            from public.sessions as session
            where session.participant_id = :'p_w'
              and session.round_id = :'r_main'
        )
    ) = 3,
    'An inclusive start boundary creates one session with the configured assignments'
);

update public.evaluation_rounds
set status = 'closed', starts_at = now() + interval '1 hour', ends_at = null
where id = :'r_main';

select is(
    public.start_or_resume_session_for_participant(:'p_a', :'r_main'),
    public.resume_session_for_participant(:'p_a', :'r_main'),
    'An existing session resumes even when its round is closed and outside the window'
);

-- Insufficient pool must fail before any write.

update public.evaluation_rounds
set status = 'open', starts_at = null, ends_at = null
where id = :'r_small';

select throws_ok(
    format(
        'select public.start_or_resume_session_for_participant(%L, %L)',
        :'p_e',
        :'r_small'
    ),
    'PT409', 'QUESTION_POOL_TOO_SMALL',
    'An insufficient eligible pool rejects the new session'
);

select ok(
    not exists (
        select 1
        from public.sessions as session
        where session.participant_id = :'p_e'
          and session.round_id = :'r_small'
    )
    and not exists (
        select 1
        from public.session_questions as assignment
        join public.sessions as session on session.id = assignment.session_id
        where session.round_id = :'r_small'
    ),
    'An insufficient pool rolls back without a session or fixed question list'
);

-- A closed batch with disabled associations and retired versions must keep
-- serving the original assigned versions.

update public.round_questions
set is_active = false
where round_id = :'r_closed';

update public.question_versions
set review_status = 'retired'
where question_id in (:'q10', :'q11', :'q12', :'q13', :'q14');

select ok(
    (
        select bool_and(not is_active)
        from public.round_questions
        where round_id = :'r_closed'
    )
    and (
        select bool_and(review_status = 'retired')
        from public.question_versions
        where question_id in (:'q10', :'q11', :'q12', :'q13', :'q14')
    ),
    'The closed-round fixture is fully disabled and retired'
);

select is(
    public.get_current_question_for_participant(:'p_b', :'s_b'),
    jsonb_build_object(
        'session', jsonb_build_object(
            'id', :'s_b'::uuid,
            'round_id', :'r_closed'::uuid,
            'status', 'in_progress',
            'assigned_count', 3,
            'rated_count', 1
        ),
        'step', 'rating',
        'question', jsonb_build_object(
            'assignment_id', :'sq_b2'::uuid,
            'position', 2,
            'question_type', 'multiple_choice',
            'stem', 'Stage 3 closed multiple choice',
            'options', '[{"id":"A","text":"Alpha"},{"id":"B","text":"Beta"},{"id":"C","text":"Gamma"}]'::jsonb
        ),
        'response_id', :'resp_b2'::uuid
    ),
    'A disabled association and retired version still serve the original assignment'
);

select is(
    public.get_current_question_for_participant(:'p_c', :'s_c'),
    jsonb_build_object(
        'session', jsonb_build_object(
            'id', :'s_c'::uuid,
            'round_id', :'r_closed'::uuid,
            'status', 'in_progress',
            'assigned_count', 1,
            'rated_count', 0
        ),
        'step', 'answer',
        'question', jsonb_build_object(
            'assignment_id', :'sq_c1'::uuid,
            'position', 1,
            'question_type', 'true_false',
            'stem', 'Stage 3 closed true false two',
            'options', '[]'::jsonb
        ),
        'response_id', null
    ),
    'The answer step still serves a retired original version'
);

-- Ownership errors use one stable code.

select throws_ok(
    format(
        'select public.get_current_question_for_participant(%L, %L)',
        :'p_a',
        :'s_b'
    ),
    'PT404', 'SESSION_NOT_FOUND',
    'A participant cannot read another participant''s session'
);

select throws_ok(
    format(
        'select public.get_current_question_for_participant(%L, %L)',
        :'p_b',
        '30000000-0000-4000-8000-0000000002ff'
    ),
    'PT404', 'SESSION_NOT_FOUND',
    'An unknown session reports the same not-found error'
);

reset role;

select * from finish();
rollback;
