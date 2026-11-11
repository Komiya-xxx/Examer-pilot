create index sessions_participant_recent_in_progress_idx
    on public.sessions (participant_id, started_at desc, id desc)
    where status = 'in_progress';

create function public.resume_session_for_participant(
    p_participant_id uuid,
    p_round_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object('session', (
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
        where session.participant_id = p_participant_id
          and session.round_id = p_round_id
    ));
$$;

create function public.get_active_round_for_participant(p_participant_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select jsonb_build_object(
        'round', (
            select jsonb_build_object(
                'id', round.id,
                'title', round.title,
                'description', round.description,
                'questions_per_session', round.questions_per_session
            )
            from public.evaluation_rounds as round
            where round.status = 'open'
              and (round.starts_at is null or round.starts_at <= now())
              and (round.ends_at is null or now() < round.ends_at)
        ),
        'session', public.resume_session_for_participant(
            p_participant_id,
            (
                select session.round_id
                from public.sessions as session
                where session.participant_id = p_participant_id
                  and session.status = 'in_progress'
                order by session.started_at desc, session.id desc
                limit 1
            )
        ) -> 'session'
    );
$$;

-- The Edge Function must supply the participant ID from its verified user JWT.
revoke all privileges on function
    public.resume_session_for_participant(uuid, uuid),
    public.get_active_round_for_participant(uuid)
from public, anon, authenticated, service_role;

grant execute on function
    public.resume_session_for_participant(uuid, uuid),
    public.get_active_round_for_participant(uuid)
to service_role;
