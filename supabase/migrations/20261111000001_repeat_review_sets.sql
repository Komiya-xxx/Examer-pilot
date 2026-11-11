-- Existing sessions are the first set. Completed sets and their assignments,
-- responses and ratings retain their IDs and version links.
alter table public.sessions
    add column set_number integer not null default 1 check (set_number > 0),
    drop constraint sessions_round_id_participant_id_key,
    add unique (round_id, participant_id, set_number);

create unique index sessions_one_in_progress_per_round_idx
    on public.sessions (round_id, participant_id)
    where status = 'in_progress';

create function public.participant_session_summary(p_participant_id uuid, p_session_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'id', session.id,
        'round_id', session.round_id,
        'status', session.status,
        'assigned_count', progress.assigned_count,
        'rated_count', progress.rated_count
    )
    from public.sessions as session
    cross join lateral (
        select count(*) as assigned_count, count(rating.id) as rated_count
        from public.session_questions as assignment
        left join public.responses as response on response.session_question_id = assignment.id
        left join public.ratings as rating on rating.response_id = response.id
        where assignment.session_id = session.id
    ) as progress
    where session.participant_id = p_participant_id and session.id = p_session_id;
$$;

create or replace function public.resume_session_for_participant(p_participant_id uuid, p_round_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object('session', public.participant_session_summary(p_participant_id, (
        select session.id from public.sessions as session
        where session.participant_id = p_participant_id and session.round_id = p_round_id
        order by session.set_number desc
        limit 1
    )));
$$;

-- Both entry points share one allocator and the existing lock order (round,
-- then candidates). The next-set path also locks the predecessor
-- before inspecting its responses, so answer and rating writes can settle.
create function public.allocate_participant_session(
    p_participant_id uuid,
    p_round_id uuid,
    p_previous_session_id uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    v_round public.evaluation_rounds%rowtype;
    v_predecessor public.sessions%rowtype;
    v_session_id uuid;
    v_set_number integer := 1;
    v_selected_ids uuid[];
begin
    if p_previous_session_id is not null then
        select session.round_id into p_round_id
        from public.sessions as session
        where session.id = p_previous_session_id and session.participant_id = p_participant_id;
        if not found then
            raise exception using errcode = 'PT404', message = 'SESSION_NOT_FOUND';
        end if;
    end if;

    select round.* into v_round
    from public.evaluation_rounds as round
    where round.id = p_round_id
    for no key update;
    if not found then
        raise exception using errcode = 'PT409', message = 'ROUND_NOT_OPEN';
    end if;

    if p_previous_session_id is null then
        select session.id into v_session_id from public.sessions as session
        where session.round_id = p_round_id and session.participant_id = p_participant_id
        order by session.set_number desc
        limit 1;
    else
        select session.* into v_predecessor from public.sessions as session
        where session.id = p_previous_session_id and session.participant_id = p_participant_id
        for no key update;
        if not found then
            raise exception using errcode = 'PT404', message = 'SESSION_NOT_FOUND';
        end if;

        v_set_number := v_predecessor.set_number + 1;
        -- Repeating the same request returns its direct successor even if the
        -- user has since moved to later sets or the batch has since closed.
        select session.id into v_session_id from public.sessions as session
        where session.round_id = p_round_id and session.participant_id = p_participant_id
          and session.set_number = v_set_number;
    end if;
    if v_session_id is not null then
        return v_session_id;
    end if;

    -- Only persisted answers count, regardless of position or rating. Small
    -- batches with fewer than six assignments still require all their answers.
    if p_previous_session_id is not null and not (
        select count(*) > 0 and count(response.id) >= least(6, count(*))
        from public.session_questions as assignment
        left join public.responses as response on response.session_question_id = assignment.id
        where assignment.session_id = p_previous_session_id
    ) then
        raise exception using errcode = 'PT409', message = 'NEXT_SET_MIN_ANSWERS_REQUIRED';
    end if;

    if v_round.status <> 'open'
        or (v_round.starts_at is not null and v_round.starts_at > clock_timestamp())
        or (v_round.ends_at is not null and v_round.ends_at <= clock_timestamp())
    then
        raise exception using errcode = 'PT409', message = 'ROUND_NOT_OPEN';
    end if;

    -- Compare logical question IDs so a new version of a previous question
    -- still cannot appear in the immediately following set.
    with locked_candidates as materialized (
        select association.id, association.question_version_id
        from public.round_questions as association
        join public.question_versions as version
          on version.id = association.question_version_id and version.question_id = association.question_id
        where association.round_id = p_round_id
          and association.is_active
          and version.review_status = 'published'
          and not exists (
              select 1 from public.session_questions as previous
              where previous.session_id = p_previous_session_id and previous.question_id = association.question_id
          )
        for share of association
    ), ranked_candidates as (
        select candidate.id, row_number() over (
            order by usage.assignment_count, randomdraw.rank, candidate.id
        ) as position
        from locked_candidates as candidate
        cross join lateral (
            select count(*) as assignment_count
            from public.session_questions as assignment
            where assignment.round_question_id = candidate.id
        ) as usage
        cross join lateral (
            select public.quality_draw_rank(
                public.question_version_quality_weight(candidate.question_version_id), random()
            ) as rank
        ) as randomdraw
    )
    select array_agg(ranked.id order by ranked.position) into v_selected_ids
    from ranked_candidates as ranked
    where ranked.position <= v_round.questions_per_session;

    -- Candidate locks may have delayed us until the time window closed.
    if v_round.ends_at is not null and v_round.ends_at <= clock_timestamp() then
        raise exception using errcode = 'PT409', message = 'ROUND_NOT_OPEN';
    end if;
    if coalesce(cardinality(v_selected_ids), 0) < v_round.questions_per_session then
        if p_previous_session_id is not null then
            raise exception using errcode = 'PT409', message = 'NEXT_SET_POOL_TOO_SMALL';
        end if;
        raise exception using errcode = 'PT409', message = 'QUESTION_POOL_TOO_SMALL';
    end if;

    -- Moving to the next set closes the current one. Keep its answers and
    -- ratings as they are and leave skipped questions without responses.
    update public.sessions as session
    set status = 'completed', completed_at = greatest(now(), session.started_at)
    where session.id = p_previous_session_id and session.status = 'in_progress';

    insert into public.sessions (round_id, participant_id, set_number)
    values (p_round_id, p_participant_id, v_set_number)
    returning id into v_session_id;

    insert into public.session_questions (session_id, round_question_id, round_id, question_id, position)
    select v_session_id, association.id, association.round_id, association.question_id, chosen.position::integer
    from unnest(v_selected_ids) with ordinality as chosen(round_question_id, position)
    join public.round_questions as association on association.id = chosen.round_question_id;

    return v_session_id;
end;
$$;

create or replace function public.start_or_resume_session_for_participant(p_participant_id uuid, p_round_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    v_session_id uuid;
begin
    v_session_id := public.allocate_participant_session(p_participant_id, p_round_id, null);
    return jsonb_build_object('session', public.participant_session_summary(p_participant_id, v_session_id));
end;
$$;

create function public.start_next_review_session_for_participant(p_participant_id uuid, p_previous_session_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    v_session_id uuid;
begin
    if p_previous_session_id is null then
        raise exception using errcode = 'PT404', message = 'SESSION_NOT_FOUND';
    end if;
    v_session_id := public.allocate_participant_session(p_participant_id, null, p_previous_session_id);
    return public.get_review_session_for_participant(p_participant_id, v_session_id);
end;
$$;

revoke all on function
    public.participant_session_summary(uuid, uuid),
    public.allocate_participant_session(uuid, uuid, uuid),
    public.start_next_review_session_for_participant(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function
    public.participant_session_summary(uuid, uuid),
    public.allocate_participant_session(uuid, uuid, uuid),
    public.start_next_review_session_for_participant(uuid, uuid)
to service_role;

-- Legacy reads and rating retries return the summary of their exact session.
create or replace function public.get_current_question_for_participant(
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
      and v_session.status = 'in_progress'
      and rating.id is null
    order by assignment.position
    limit 1;

    if not found then
        v_step := 'completed';
        v_question := null;
        v_response_id := null;
    end if;

    return jsonb_build_object(
        'session', public.participant_session_summary(p_participant_id, v_session.id),
        'step', v_step,
        'question', v_question,
        'response_id', v_response_id
    );
end;
$$;

create or replace function public.submit_rating_for_participant(
    p_participant_id uuid,
    p_response_id uuid,
    p_quality text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    v_status text;
    v_session_id uuid;
    v_assignment_id uuid;
    v_rating_id uuid;
    v_existing_quality text;
    v_current_id uuid;
    v_unrated integer;
begin
    -- Same lock as answer submission, so concurrent writes to one session serialize.
    select s.status, s.id
    into v_status, v_session_id
    from public.sessions as s
    join public.session_questions as a on a.session_id = s.id
    join public.responses as r on r.session_question_id = a.id
    where s.participant_id = p_participant_id and r.id = p_response_id
    for no key update of s;
    if not found then
        raise exception using errcode = 'PT404', message = 'RESPONSE_NOT_FOUND';
    end if;

    select a.id into v_assignment_id
    from public.responses as r
    join public.session_questions as a on a.id = r.session_question_id
    where r.id = p_response_id;

    if p_quality is null or p_quality not in ('low', 'medium', 'high') then
        raise exception using errcode = 'PT400', message = 'INVALID_QUALITY';
    end if;

    select t.id, t.quality into v_rating_id, v_existing_quality
    from public.ratings as t where t.response_id = p_response_id;
    if found then
        if v_existing_quality is distinct from p_quality then
            raise exception using errcode = 'PT409', message = 'RATING_ALREADY_SUBMITTED';
        end if;
        return jsonb_build_object('rating_id', v_rating_id, 'session',
            public.participant_session_summary(p_participant_id, v_session_id));
    end if;

    if v_status <> 'in_progress' then
        raise exception using errcode = 'PT409', message = 'SESSION_COMPLETED';
    end if;

    -- Mirror answer submission: an unanswered or unrated assignment blocks the step.
    select a.id into v_current_id
    from public.session_questions as a
    left join public.responses as r on r.session_question_id = a.id
    left join public.ratings as t on t.response_id = r.id
    where a.session_id = v_session_id and t.id is null
    order by a.position
    limit 1;
    if v_current_id is distinct from v_assignment_id then
        raise exception using errcode = 'PT409', message = 'NOT_CURRENT_QUESTION';
    end if;

    insert into public.ratings (response_id, quality)
    values (p_response_id, p_quality)
    returning id into v_rating_id;

    select count(*) into v_unrated
    from public.session_questions as a
    left join public.responses as r on r.session_question_id = a.id
    left join public.ratings as t on t.response_id = r.id
    where a.session_id = v_session_id and t.id is null;

    if v_unrated > 0 then
        return jsonb_build_object('rating_id', v_rating_id, 'session',
            public.participant_session_summary(p_participant_id, v_session_id));
    end if;

    -- The last rating and the completion commit together. Explicit timestamps
    -- keep the completion constraint true even for a backdated start.
    update public.sessions as s
    set status = 'completed', completed_at = greatest(now(), s.started_at)
    where s.id = v_session_id and s.status = 'in_progress';

    return jsonb_build_object('rating_id', v_rating_id, 'session',
        public.participant_session_summary(p_participant_id, v_session_id));
end;
$$;

-- Refresh restores the most recent eligible session without allocating a set.
create or replace function public.get_active_round_for_participant(p_participant_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    with active_round as (
        select round.id, round.title, round.description, round.questions_per_session
        from public.evaluation_rounds as round
        where round.status = 'open'
          and (round.starts_at is null or round.starts_at <= now())
          and (round.ends_at is null or now() < round.ends_at)
        order by round.starts_at desc nulls first, round.id
        limit 1
    )
    select jsonb_build_object(
        'round', (
            select jsonb_build_object(
                'id', round.id,
                'title', round.title,
                'description', round.description,
                'questions_per_session', round.questions_per_session
            )
            from active_round as round
        ),
        'session', public.participant_session_summary(
            p_participant_id,
            (
                select session.id
                from public.sessions as session
                left join active_round as round on round.id = session.round_id
                where session.participant_id = p_participant_id
                  and (
                      session.status = 'in_progress'
                      or (
                          session.status = 'completed'
                          and (round.id is not null or not exists (select 1 from active_round))
                      )
                  )
                order by (session.status = 'in_progress') desc,
                         session.started_at desc,
                         session.set_number desc,
                         session.id desc
                limit 1
            )
        )
    );
$$;
