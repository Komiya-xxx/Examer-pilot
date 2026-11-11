-- Stage 3: atomic session start/resume and fixed question distribution.
--
-- Distribution only uses the round lock and the actual assignment counts
-- recorded in session_questions. Quality weights arrive in a later stage, so
-- every candidate has equal sampling weight here.

create function public.start_or_resume_session_for_participant(
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
               association.question_id
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
                            random(),
                            candidate.id
               ) as position
        from locked_candidates as candidate
        cross join lateral (
            select count(*) as assignment_count
            from public.session_questions as assignment
            where assignment.round_question_id = candidate.id
        ) as usage
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

create function public.get_current_question_for_participant(
    p_participant_id uuid,
    p_session_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    v_session record;
    v_step text;
    v_question jsonb;
    v_response_id uuid;
begin
    select session.id,
           session.round_id,
           session.status
    into v_session
    from public.sessions as session
    where session.id = p_session_id
      and session.participant_id = p_participant_id;

    -- Unknown and foreign sessions use the same error on purpose.
    if not found then
        raise exception using
            errcode = 'PT404',
            message = 'SESSION_NOT_FOUND';
    end if;

    -- The first assignment without a rating is the current step. An assigned
    -- question keeps serving its original version even after the batch is
    -- closed, the association disabled, or the version retired, so no active
    -- or review-status filter is applied to the assignment lookup.
    select case
               when response.id is null then 'answer'
               else 'rating'
           end,
           jsonb_build_object(
               'assignment_id', assignment.id,
               'position', assignment.position,
               'question_type', version.question_type,
               'stem', version.stem,
               'options', coalesce(option_projection.items, '[]'::jsonb)
           ),
           response.id
    into v_step,
         v_question,
         v_response_id
    from public.session_questions as assignment
    join public.round_questions as association
      on association.id = assignment.round_question_id
    join public.question_versions as version
      on version.id = association.question_version_id
    left join public.responses as response
      on response.session_question_id = assignment.id
    left join public.ratings as rating
      on rating.response_id = response.id
    left join lateral (
        select jsonb_agg(
                   jsonb_build_object(
                       'id', option.value ->> 'id',
                       'text', option.value ->> 'text'
                   )
                   order by option.ordinality
               ) as items
        from jsonb_array_elements(version.options) with ordinality
             as option(value, ordinality)
    ) as option_projection on true
    where assignment.session_id = v_session.id
      and rating.id is null
    order by assignment.position
    limit 1;

    if not found then
        v_step := 'completed';
        v_question := null;
        v_response_id := null;
    end if;

    return jsonb_build_object(
        'session', public.resume_session_for_participant(
            p_participant_id,
            v_session.round_id
        ) -> 'session',
        'step', v_step,
        'question', v_question,
        'response_id', v_response_id
    );
end;
$$;

-- The Edge Function must supply the participant ID from its verified user JWT.
revoke all privileges on function
    public.start_or_resume_session_for_participant(uuid, uuid),
    public.get_current_question_for_participant(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
    public.start_or_resume_session_for_participant(uuid, uuid),
    public.get_current_question_for_participant(uuid, uuid)
to service_role;
