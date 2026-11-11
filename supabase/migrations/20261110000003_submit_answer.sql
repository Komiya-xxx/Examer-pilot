-- Serialize answer and rating writes with the same lock on the owned session.
create function public.submit_answer_for_participant(
    p_participant_id uuid,
    p_session_id uuid,
    p_assignment_id uuid,
    p_answer jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    v_status text;
    v_type text;
    v_options jsonb;
    v_answer jsonb;
    v_existing jsonb;
    v_response_id uuid;
    v_current_id uuid;
begin
    select s.status into v_status
    from public.sessions s
    where s.id = p_session_id and s.participant_id = p_participant_id
    for no key update;
    if not found then
        raise exception using errcode = 'PT404', message = 'SESSION_NOT_FOUND';
    end if;

    -- Follow the stored association, including a disabled or retired version.
    select v.question_type, v.options into v_type, v_options
    from public.session_questions a
    join public.round_questions rq on rq.id = a.round_question_id
    join public.question_versions v on v.id = rq.question_version_id
    where a.id = p_assignment_id and a.session_id = p_session_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'ASSIGNMENT_NOT_FOUND';
    end if;

    if v_type = 'single_choice' then
        if jsonb_typeof(p_answer) is distinct from 'string' or not exists (
            select 1 from jsonb_array_elements(v_options) as option(item)
            where option.item -> 'id' = p_answer
        ) then
            raise exception using errcode = 'PT400', message = 'INVALID_ANSWER';
        end if;
        v_answer := p_answer;
    elsif v_type = 'multiple_choice' then
        if jsonb_typeof(p_answer) is distinct from 'array' then
            raise exception using errcode = 'PT400', message = 'INVALID_ANSWER';
        end if;
        if jsonb_array_length(p_answer) = 0 or exists (
            select 1
            from jsonb_array_elements(p_answer) as selected(item)
            where jsonb_typeof(selected.item) is distinct from 'string'
               or not exists (
                    select 1 from jsonb_array_elements(v_options) as option(item)
                    where option.item -> 'id' = selected.item
               )
        ) then
            raise exception using errcode = 'PT400', message = 'INVALID_ANSWER';
        end if;

        select jsonb_agg(option_id order by first_position) into v_answer
        from (
            select option.item -> 'id' as option_id, min(option.position) as first_position
            from jsonb_array_elements(v_options) with ordinality as option(item, position)
            where p_answer ? (option.item ->> 'id')
            group by option.item -> 'id'
        ) as matched;
    else
        if jsonb_typeof(p_answer) is distinct from 'boolean' then
            raise exception using errcode = 'PT400', message = 'INVALID_ANSWER';
        end if;
        v_answer := p_answer;
    end if;

    select r.id, r.selected_answer into v_response_id, v_existing
    from public.responses r where r.session_question_id = p_assignment_id;
    if found then
        if v_existing is distinct from v_answer then
            raise exception using errcode = 'PT409', message = 'ANSWER_ALREADY_SUBMITTED';
        end if;
        return jsonb_build_object('response_id', v_response_id, 'step', 'rating');
    end if;

    if v_status <> 'in_progress' then
        raise exception using errcode = 'PT409', message = 'SESSION_COMPLETED';
    end if;

    select a.id into v_current_id
    from public.session_questions a
    left join public.responses r on r.session_question_id = a.id
    left join public.ratings t on t.response_id = r.id
    where a.session_id = p_session_id and t.id is null
    order by a.position
    limit 1;
    if v_current_id is distinct from p_assignment_id then
        raise exception using errcode = 'PT409', message = 'NOT_CURRENT_QUESTION';
    end if;

    insert into public.responses (session_question_id, selected_answer)
    values (p_assignment_id, v_answer)
    returning id into v_response_id;
    return jsonb_build_object('response_id', v_response_id, 'step', 'rating');
end;
$$;

revoke all on function public.submit_answer_for_participant(uuid, uuid, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.submit_answer_for_participant(uuid, uuid, uuid, jsonb)
to service_role;
