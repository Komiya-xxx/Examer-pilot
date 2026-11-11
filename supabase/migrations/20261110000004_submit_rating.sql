-- Stage 5: record a quality rating and finish the owned session.

create function public.submit_rating_for_participant(
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
    v_round_id uuid;
    v_status text;
    v_session_id uuid;
    v_assignment_id uuid;
    v_rating_id uuid;
    v_existing_quality text;
    v_current_id uuid;
    v_unrated integer;
begin
    -- Same lock as answer submission, so concurrent writes to one session serialize.
    select s.round_id, s.status, s.id
    into v_round_id, v_status, v_session_id
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
            public.resume_session_for_participant(p_participant_id, v_round_id) -> 'session');
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
            public.resume_session_for_participant(p_participant_id, v_round_id) -> 'session');
    end if;

    -- The last rating and the completion commit together. Explicit timestamps
    -- keep the completion constraint true even for a backdated start.
    update public.sessions as s
    set status = 'completed', completed_at = greatest(now(), s.started_at)
    where s.id = v_session_id and s.status = 'in_progress';

    return jsonb_build_object('rating_id', v_rating_id, 'session',
        public.resume_session_for_participant(p_participant_id, v_round_id) -> 'session');
end;
$$;

revoke all on function public.submit_rating_for_participant(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.submit_rating_for_participant(uuid, uuid, text)
to service_role;

-- Prefer the latest unfinished session; otherwise surface the newest owned
-- completed session of the open round so a refresh keeps showing completion.
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
        'session', public.resume_session_for_participant(
            p_participant_id,
            (
                select session.round_id
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
                         session.id desc
                limit 1
            )
        ) -> 'session'
    );
$$;
