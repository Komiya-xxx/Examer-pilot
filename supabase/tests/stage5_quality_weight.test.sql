begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(12);

-- Helper shape and permissions.

select ok(
    not has_function_privilege('anon', 'public.question_version_quality_weight(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.question_version_quality_weight(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.question_version_quality_weight(uuid)', 'execute'),
    'Only the server role can compute a version weight'
);

select ok(
    not has_function_privilege('anon', 'public.quality_draw_rank(double precision, double precision)', 'execute')
    and not has_function_privilege('authenticated', 'public.quality_draw_rank(double precision, double precision)', 'execute')
    and has_function_privilege('service_role', 'public.quality_draw_rank(double precision, double precision)', 'execute'),
    'Only the server role can compute a draw rank'
);

select is(
    (select procedure.provolatile::text
       from pg_proc as procedure
      where procedure.oid = 'public.quality_draw_rank(double precision, double precision)'::regprocedure),
    'i',
    'The draw rank is immutable'
);

select ok(
    not exists (
        select 1
          from pg_proc as procedure
          cross join lateral aclexplode(
              coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) as privilege
         where procedure.oid in (
             'public.question_version_quality_weight(uuid)'::regprocedure,
             'public.quality_draw_rank(double precision, double precision)'::regprocedure
         )
           and privilege.grantee = 0
           and privilege.privilege_type = 'EXECUTE'
    ),
    'Neither weight helper keeps a default PUBLIC execute grant'
);

-- Fixtures. Every batch is closed because the schema permits at most one open
-- round at a time; weights depend only on recorded ratings, not round status.

set local role service_role;

-- STAGE5-W-UNRATED..HIGH are four single-version questions. STAGE5-W-REUSED
-- holds two versions: v1 is rated in two rounds, v2 is its independent newer
-- sibling that carries no weight from v1.
insert into public.questions (external_id) values
    ('STAGE5-W-UNRATED'), ('STAGE5-W-LOW'), ('STAGE5-W-MED'), ('STAGE5-W-HIGH'),
    ('STAGE5-W-REUSED');

insert into public.question_versions (question_id, version_no, question_type, stem, options, review_status)
select q.id, v.no, 'true_false', 'Synthetic statement', '[]'::jsonb, 'published'
from (values
    ('STAGE5-W-UNRATED', 1),
    ('STAGE5-W-LOW',     1),
    ('STAGE5-W-MED',     1),
    ('STAGE5-W-HIGH',    1),
    ('STAGE5-W-REUSED',  1),
    ('STAGE5-W-REUSED',  2)
) as v(ext, no)
join public.questions q on q.external_id = v.ext;

-- Rated rounds are all closed.
insert into public.evaluation_rounds (slug, title, status, questions_per_session) values
    ('stage5-w-low',  'Stage 5 low',  'closed', 1),
    ('stage5-w-med',  'Stage 5 med',  'closed', 1),
    ('stage5-w-high', 'Stage 5 high', 'closed', 1),
    ('stage5-w-r1',   'Stage 5 reuse A', 'closed', 1),
    ('stage5-w-r2',   'Stage 5 reuse B', 'closed', 1);

insert into public.round_questions (round_id, question_version_id, question_id, is_active)
select r.id, qv.id, qv.question_id, true
from (values
    ('stage5-w-low',  'STAGE5-W-LOW',    1),
    ('stage5-w-med',  'STAGE5-W-MED',    1),
    ('stage5-w-high', 'STAGE5-W-HIGH',   1),
    ('stage5-w-r1',   'STAGE5-W-REUSED', 1),
    ('stage5-w-r2',   'STAGE5-W-REUSED', 1)
) as m(round_slug, q_ext, no)
join public.evaluation_rounds r on r.slug = m.round_slug
join public.question_versions qv on qv.question_id = (
    select q.id from public.questions q where q.external_id = m.q_ext
) and qv.version_no = m.no;

insert into public.sessions (round_id, participant_id, status)
select r.id, gen_random_uuid(), 'in_progress'
from public.evaluation_rounds r
where r.slug in ('stage5-w-low', 'stage5-w-med', 'stage5-w-high', 'stage5-w-r1', 'stage5-w-r2');

insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
select s.id, rq.id, s.round_id, rq.question_id, 1
from public.sessions s
join public.round_questions rq on rq.round_id = s.round_id
join public.evaluation_rounds r on r.id = s.round_id
where r.slug like 'stage5-w-%';

insert into public.responses (session_question_id, selected_answer)
select sq.id, 'true'
from public.session_questions sq
join public.evaluation_rounds r on r.id = sq.round_id
where r.slug like 'stage5-w-%';

-- Rate each response according to its round's version.
insert into public.ratings (response_id, quality)
select r.id, case q.external_id
    when 'STAGE5-W-LOW'  then 'low'
    when 'STAGE5-W-MED'  then 'medium'
    when 'STAGE5-W-HIGH' then 'high'
    when 'STAGE5-W-REUSED' then
        case when rq.round_id = (select id from public.evaluation_rounds where slug = 'stage5-w-r1')
             then 'high' else 'low' end
end
from public.responses r
join public.session_questions sq on sq.id = r.session_question_id
join public.round_questions rq on rq.id = sq.round_question_id
join public.question_versions qv on qv.id = rq.question_version_id
join public.questions q on q.id = qv.question_id
where q.external_id in ('STAGE5-W-LOW', 'STAGE5-W-MED', 'STAGE5-W-HIGH', 'STAGE5-W-REUSED');

-- Weight assertions (helpers are service-role only; we are already that role).

select is(
    public.question_version_quality_weight(
        (select qv.id from public.question_versions qv join public.questions q on q.id = qv.question_id where q.external_id = 'STAGE5-W-UNRATED')
    ),
    1.0::double precision,
    'A version without ratings yields the neutral prior 1'
);

select is(
    public.question_version_quality_weight(
        (select qv.id from public.question_versions qv join public.questions q on q.id = qv.question_id where q.external_id = 'STAGE5-W-LOW')
    ),
    (2.5::double precision / 3.0::double precision),
    'A single low rating yields weight 2.5/3'
);

select is(
    public.question_version_quality_weight(
        (select qv.id from public.question_versions qv join public.questions q on q.id = qv.question_id where q.external_id = 'STAGE5-W-MED')
    ),
    1.0::double precision,
    'A single medium rating yields weight 1'
);

select is(
    public.question_version_quality_weight(
        (select qv.id from public.question_versions qv join public.questions q on q.id = qv.question_id where q.external_id = 'STAGE5-W-HIGH')
    ),
    (3.5::double precision / 3.0::double precision),
    'A single high rating yields weight 3.5/3'
);

select is(
    public.question_version_quality_weight(
        (select qv.id from public.question_versions qv join public.questions q on q.id = qv.question_id
          where q.external_id = 'STAGE5-W-REUSED' and qv.version_no = 1)
    ),
    1.0::double precision,
    'The same version rated high and low in two closed rounds yields weight 1'
);

select is(
    public.question_version_quality_weight(
        (select qv.id from public.question_versions qv join public.questions q on q.id = qv.question_id
          where q.external_id = 'STAGE5-W-REUSED' and qv.version_no = 2)
    ),
    1.0::double precision,
    'A newer version carries no weight from the older version'
);

-- Draw rank ordering at a fixed draw.

select is(
    round(public.quality_draw_rank(2.0, 0.5)::numeric, 12),
    0.346573590280::numeric,
    'A fixed draw and weight produce a deterministic exponential key'
);

select ok(
    public.quality_draw_rank(3.5::double precision / 3.0::double precision, 0.5::double precision)
        < public.quality_draw_rank(2.5::double precision / 3.0::double precision, 0.5::double precision),
    'A higher weight ranks earlier than a lower weight at the same fixed draw'
);

reset role;

select * from finish();
rollback;
