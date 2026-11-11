-- Stage 5: quality-weighted question distribution.
--
-- A question version's weight is derived from every rating of every response
-- to an assignment that served that exact version, regardless of which round,
-- session, or whether the version was later retired or disabled. The session
-- start RPC keeps its stage 3 locking, ordering and errors; only the secondary
-- sort key changes from random() to the quality draw rank.

create function public.question_version_quality_weight(p_question_version_id uuid)
returns double precision
language sql
stable
security invoker
set search_path = ''
as $$
    with tally as (
        select count(*)::numeric as rated_count,
               count(*) filter (where rating.quality = 'low')::numeric as low_count,
               count(*) filter (where rating.quality = 'medium')::numeric as medium_count,
               count(*) filter (where rating.quality = 'high')::numeric as high_count
        from public.round_questions as association
        join public.session_questions as assignment
          on assignment.round_question_id = association.id
        join public.responses as response
          on response.session_question_id = assignment.id
        join public.ratings as rating
          on rating.response_id = response.id
        where association.question_version_id = p_question_version_id
    )
    select (
        2::numeric
        + 0.5::numeric * tally.low_count
        + 1::numeric * tally.medium_count
        + 1.5::numeric * tally.high_count
    ) / (2::numeric + tally.rated_count)
    from tally;
$$;

-- Draw rank for weighted sampling. A fixed draw p_draw in (0, 1) is turned
-- into the exponential key -ln(1 - p_draw) / p_weight, so a larger weight
-- scales every draw down by the same factor and therefore ranks earlier.
create function public.quality_draw_rank(p_weight double precision, p_draw double precision)
returns double precision
language sql
immutable
security invoker
set search_path = ''
as $$
    select -ln(1::double precision - p_draw) / p_weight;
$$;

create or replace function public.start_or_resume_session_for_participant(
    p_participant_id uuid,
    p_round_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    v_round record;
    v_session_id uuid;
    v_selected_round_question_ids uuid[];
begin
    -- Serialize starts within the round. Stage 1 grants the column UPDATE
    -- privileges that this row lock requires.
    select round.id,
           round.status,
           round.questions_per_session,
           round.starts_at,
           round.ends_at
    into v_round
    from public.evaluation_rounds as round
    where round.id = p_round_id
    for no key update;

    if not found then
        raise exception using
            errcode = 'PT409',
            message = 'ROUND_NOT_OPEN';
    end if;

    -- An existing own session is always resumable, regardless of the round
    -- status or its time window.
    if exists (
        select 1
        from public.sessions as session
        where session.participant_id = p_participant_id
          and session.round_id = p_round_id
    ) then
        return public.resume_session_for_participant(p_participant_id, p_round_id);
    end if;

    -- Only a genuinely new session requires an eligible round.
    if v_round.status <> 'open'
        or (v_round.starts_at is not null and v_round.starts_at > clock_timestamp())
        or (v_round.ends_at is not null and v_round.ends_at <= clock_timestamp())
    then
        raise exception using
            errcode = 'PT409',
            message = 'ROUND_NOT_OPEN';
    end if;

    -- Lock every eligible candidate before the insert so a concurrent
    -- deactivation cannot change the pool after it has been sampled. Active
    -- associations are always published because of the review-status foreign
    -- key, but the explicit filter keeps the intent visible.
    with locked_candidates as materialized (
        select association.id,
               association.question_version_id
        from public.round_questions as association
        join public.question_versions as version
          on version.id = association.question_version_id
         and version.question_id = association.question_id
        where association.round_id = p_round_id
          and association.is_active
          and version.review_status = 'published'
        for share of association
    ),
    ranked_candidates as (
        select candidate.id,
               row_number() over (
                   order by usage.assignment_count,
                            randomdraw.rank,
                            candidate.id
               ) as position
        from locked_candidates as candidate
        cross join lateral (
            select count(*) as assignment_count
            from public.session_questions as assignment
            where assignment.round_question_id = candidate.id
        ) as usage
        -- random() is called once per candidate so the comparison has a
        -- concrete draw per row rather than one shared volatile value.
        cross join lateral (
            select public.quality_draw_rank(
                public.question_version_quality_weight(candidate.question_version_id),
                random()
            ) as rank
        ) as randomdraw
    )
    select array_agg(ranked.id order by ranked.position)
    into v_selected_round_question_ids
    from ranked_candidates as ranked
    where ranked.position <= v_round.questions_per_session;

    -- The window may have closed while this transaction waited for candidate
    -- locks.
    if v_round.status <> 'open'
        or (v_round.starts_at is not null and v_round.starts_at > clock_timestamp())
        or (v_round.ends_at is not null and v_round.ends_at <= clock_timestamp())
    then
        raise exception using
            errcode = 'PT409',
            message = 'ROUND_NOT_OPEN';
    end if;

    if coalesce(cardinality(v_selected_round_question_ids), 0)
        < v_round.questions_per_session
    then
        raise exception using
            errcode = 'PT409',
            message = 'QUESTION_POOL_TOO_SMALL';
    end if;

    insert into public.sessions (round_id, participant_id)
    values (p_round_id, p_participant_id)
    returning id into v_session_id;

    -- The sampled order is the fixed order of the session; one position per
    -- chosen association.
    insert into public.session_questions (
        session_id,
        round_question_id,
        round_id,
        question_id,
        position
    )
    select v_session_id,
           association.id,
           association.round_id,
           association.question_id,
           chosen.position::integer
    from unnest(v_selected_round_question_ids) with ordinality
         as chosen(round_question_id, position)
    join public.round_questions as association
      on association.id = chosen.round_question_id;

    return public.resume_session_for_participant(p_participant_id, p_round_id);
end;
$$;

-- Weight and draw helpers stay server-side; the RPC is rebuilt in place and
-- keeps the stage 3 execute grant on its unchanged signature.
revoke all privileges on function
    public.question_version_quality_weight(uuid),
    public.quality_draw_rank(double precision, double precision)
from public, anon, authenticated, service_role;

grant execute on function
    public.question_version_quality_weight(uuid),
    public.quality_draw_rank(double precision, double precision)
to service_role;
