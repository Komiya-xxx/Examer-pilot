-- Review material is attached to the exact version already in each fixed assignment.
-- The live pilot's keys are loaded separately, never in a migration or site asset.
create table examerframe_private.question_feedback (
    question_version_id uuid primary key references public.question_versions(id) on delete restrict,
    standard_answer jsonb not null,
    explanation text not null check (length(btrim(explanation)) > 0),
    check (jsonb_typeof(standard_answer) in ('string', 'array', 'boolean'))
);
alter table examerframe_private.question_feedback enable row level security;
revoke all on table examerframe_private.question_feedback from public, anon, authenticated, service_role;
grant select on table examerframe_private.question_feedback to service_role;

-- Existing ratings cannot reliably be classified retrospectively.
alter table public.ratings add column source text not null default 'legacy'
    check (source in ('legacy', 'default', 'explicit'));

-- Normalize a learner or a curator answer identically. In particular, order and
-- duplicate selections do not affect a multiple-choice answer's correctness.
create function public.normalize_review_answer(p_type text, p_options jsonb, p_answer jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
    normalized jsonb;
begin
    if p_type = 'single_choice' and jsonb_typeof(p_answer) = 'string' and exists (
        select 1 from jsonb_array_elements(p_options) as option(item) where option.item->'id' = p_answer
    ) then
        return p_answer;
    elsif p_type = 'true_false' and jsonb_typeof(p_answer) = 'boolean' then
        return p_answer;
    elsif p_type = 'multiple_choice' and jsonb_typeof(p_answer) = 'array' then
        if jsonb_array_length(p_answer) > 0 and not exists (
            select 1 from jsonb_array_elements(p_answer) as selected(item)
            where not exists (select 1 from jsonb_array_elements(p_options) as option(item)
                where option.item->'id' = selected.item)
        ) then
            select jsonb_agg(option.item->'id' order by option.position) into normalized
            from jsonb_array_elements(p_options) with ordinality as option(item, position)
            where p_answer ? (option.item->>'id');
            return normalized;
        end if;
    end if;
    raise exception using errcode = 'PT400', message = 'INVALID_ANSWER';
end;
$$;

-- One authenticated read provides the fixed question list. The feedback join is
-- conditional on a stored response for that exact assignment in the owned session.
create function public.get_review_session_for_participant(p_participant_id uuid, p_session_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    session_status text;
    questions jsonb;
begin
    select s.status into session_status from public.sessions s
    where s.id = p_session_id and s.participant_id = p_participant_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'SESSION_NOT_FOUND';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
        'assignment_id', a.id, 'position', a.position, 'question_type', v.question_type,
        'stem', v.stem, 'options', v.options,
        'response', case when r.id is not null then jsonb_build_object(
            'id', r.id, 'selected_answer', r.selected_answer,
            'rating', case when t.id is not null then jsonb_build_object('quality', t.quality, 'source', t.source) end,
            'feedback', case when f.question_version_id is not null then jsonb_build_object(
                'correct', r.selected_answer = f.standard_answer,
                'standard_answer', f.standard_answer, 'explanation', f.explanation
            ) end
        ) end
    ) order by a.position), '[]'::jsonb) into questions
    from public.session_questions a
    join public.round_questions rq on rq.id = a.round_question_id
    join public.question_versions v on v.id = rq.question_version_id
    left join public.responses r on r.session_question_id = a.id
    left join public.ratings t on t.response_id = r.id
    left join examerframe_private.question_feedback f on f.question_version_id = v.id and r.id is not null
    where a.session_id = p_session_id;

    return jsonb_build_object('session_id', p_session_id, 'status', session_status, 'questions', questions);
end;
$$;

create function public.submit_review_answer_for_participant(
    p_participant_id uuid, p_session_id uuid, p_assignment_id uuid, p_answer jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    session_status text;
    question_kind text;
    question_options jsonb;
    normalized jsonb;
    saved_answer jsonb;
    response_id uuid;
begin
    -- Share the session lock with legacy clients and both rating paths.
    select s.status into session_status from public.sessions s
    where s.id = p_session_id and s.participant_id = p_participant_id
    for no key update;
    if not found then
        raise exception using errcode = 'PT404', message = 'SESSION_NOT_FOUND';
    end if;

    select v.question_type, v.options into question_kind, question_options
    from public.session_questions a
    join public.round_questions rq on rq.id = a.round_question_id
    join public.question_versions v on v.id = rq.question_version_id
    where a.id = p_assignment_id and a.session_id = p_session_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'ASSIGNMENT_NOT_FOUND';
    end if;
    normalized := public.normalize_review_answer(question_kind, question_options, p_answer);

    select r.id, r.selected_answer into response_id, saved_answer
    from public.responses r where r.session_question_id = p_assignment_id;
    if found then
        if saved_answer is distinct from normalized then
            raise exception using errcode = 'PT409', message = 'ANSWER_ALREADY_SUBMITTED';
        end if;
    else
        if session_status <> 'in_progress' then
            raise exception using errcode = 'PT409', message = 'SESSION_COMPLETED';
        end if;
        insert into public.responses (session_question_id, selected_answer)
        values (p_assignment_id, normalized) returning id into response_id;
        insert into public.ratings (response_id, quality, source)
        values (response_id, 'medium', 'default');

        if not exists (
            select 1 from public.session_questions a
            where a.session_id = p_session_id and not exists (
                select 1 from public.responses r where r.session_question_id = a.id
            )
        ) then
            update public.sessions s set status = 'completed', completed_at = greatest(now(), s.started_at)
            where s.id = p_session_id;
        end if;
    end if;
    return public.get_review_session_for_participant(p_participant_id, p_session_id);
end;
$$;

create function public.submit_review_rating_for_participant(p_participant_id uuid, p_response_id uuid, p_quality text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
    session_id uuid;
    current_rating public.ratings%rowtype;
begin
    select s.id into session_id
    from public.responses r
    join public.session_questions a on a.id = r.session_question_id
    join public.sessions s on s.id = a.session_id
    where r.id = p_response_id and s.participant_id = p_participant_id
    for no key update of s;
    if not found then
        raise exception using errcode = 'PT404', message = 'RESPONSE_NOT_FOUND';
    end if;
    if p_quality is null or p_quality not in ('low', 'medium', 'high') then
        raise exception using errcode = 'PT400', message = 'INVALID_QUALITY';
    end if;

    select t.* into current_rating from public.ratings t where t.response_id = p_response_id;
    if not found then
        insert into public.ratings (response_id, quality, source) values (p_response_id, p_quality, 'explicit');
    elsif current_rating.source = 'default' then
        update public.ratings t set quality = p_quality, source = 'explicit', submitted_at = now()
        where t.id = current_rating.id;
    elsif current_rating.quality is distinct from p_quality then
        raise exception using errcode = 'PT409', message = 'RATING_ALREADY_SUBMITTED';
    end if;

    -- An older client may have left its very last answer pending evaluation.
    update public.sessions s set status = 'completed', completed_at = greatest(now(), s.started_at)
    where s.id = session_id and s.status = 'in_progress' and not exists (
        select 1 from public.session_questions a where a.session_id = s.id and not exists (
            select 1 from public.responses r where r.session_question_id = a.id
        )
    );
    return public.get_review_session_for_participant(p_participant_id, session_id);
end;
$$;

revoke all on function
    public.normalize_review_answer(text, jsonb, jsonb),
    public.get_review_session_for_participant(uuid, uuid),
    public.submit_review_answer_for_participant(uuid, uuid, uuid, jsonb),
    public.submit_review_rating_for_participant(uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function
    public.normalize_review_answer(text, jsonb, jsonb),
    public.get_review_session_for_participant(uuid, uuid),
    public.submit_review_answer_for_participant(uuid, uuid, uuid, jsonb),
    public.submit_review_rating_for_participant(uuid, uuid, text)
to service_role;

-- The existing table grants allow inserts but intentionally deny updates.
grant update (quality, source, submitted_at) on public.ratings to service_role;
