create function public.list_student_responses(p_participant_id uuid, p_page integer, p_wrong_only boolean)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
    result jsonb;
    page_size constant integer := 12;
begin
    perform examerframe_private.require_student(p_participant_id);
    if p_page is null or p_page < 1 or p_wrong_only is null then
        raise exception using errcode = 'PT400', message = 'INVALID_REQUEST';
    end if;

    with answers as (
        select r.question_version_id, row_number() over (order by r.submitted_at desc, r.id) as position
        from examerframe_private.student_responses r
        where r.student_id = p_participant_id and (not p_wrong_only or r.correct is false)
    ), totals as (
        select count(*) total_count, (count(*) + page_size - 1) / page_size total_pages from answers
    ), pagination as (
        select total_count, total_pages, greatest(1, least(p_page, total_pages)) as page from totals
    ), displayed as materialized (
        select a.* from answers a cross join pagination p
        where a.position between (p.page - 1) * page_size + 1 and p.page * page_size
    )
    select jsonb_build_object(
        'page', p.page, 'total_count', p.total_count, 'total_pages', p.total_pages,
        'questions', coalesce((select jsonb_agg(
            examerframe_private.student_question(p_participant_id, d.question_version_id) order by d.position
        ) from displayed d), '[]'::jsonb)
    ) into result
    from pagination p;
    return result;
end;
$$;

create function public.review_student_mistake(p_participant_id uuid, p_response_id uuid)
returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
    version_id uuid;
begin
    perform examerframe_private.require_student(p_participant_id);
    update examerframe_private.student_responses
    set reviewed_at = clock_timestamp()
    where id = p_response_id and student_id = p_participant_id and correct is false
    returning question_version_id into version_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'RESPONSE_NOT_FOUND';
    end if;
    return examerframe_private.student_question(p_participant_id, version_id);
end;
$$;

create function public.submit_student_retry(p_participant_id uuid, p_response_id uuid, p_attempt_id uuid, p_answer jsonb)
returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
    first_response examerframe_private.student_responses%rowtype;
    normalized jsonb;
    saved jsonb;
begin
    perform examerframe_private.require_student(p_participant_id);
    select * into first_response from examerframe_private.student_responses
    where id = p_response_id and student_id = p_participant_id and correct is false;
    if not found then
        raise exception using errcode = 'PT404', message = 'RESPONSE_NOT_FOUND';
    end if;

    select public.normalize_review_answer(v.question_type, v.options, p_answer) into normalized
    from public.question_versions v where v.id = first_response.question_version_id;
    insert into examerframe_private.student_retries (response_id, attempt_id, selected_answer, correct)
    values (p_response_id, p_attempt_id, normalized, normalized = first_response.standard_answer)
    on conflict (response_id, attempt_id) do nothing;
    if not found then
        select selected_answer into saved from examerframe_private.student_retries
        where response_id = p_response_id and attempt_id = p_attempt_id;
        if saved is distinct from normalized then
            raise exception using errcode = 'PT409', message = 'RETRY_ALREADY_SUBMITTED';
        end if;
    end if;
    return examerframe_private.student_question(p_participant_id, first_response.question_version_id);
end;
$$;

create function public.save_student_rating(p_participant_id uuid, p_response_id uuid, p_quality text)
returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
    version_id uuid;
    saved text;
begin
    perform examerframe_private.require_student(p_participant_id);
    select question_version_id into version_id from examerframe_private.student_responses
    where id = p_response_id and student_id = p_participant_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'RESPONSE_NOT_FOUND';
    end if;
    if p_quality is null or p_quality not in ('low', 'high') then
        raise exception using errcode = 'PT400', message = 'INVALID_QUALITY';
    end if;

    insert into examerframe_private.student_response_ratings (response_id, quality)
    values (p_response_id, p_quality) on conflict (response_id) do nothing;
    if not found then
        select quality into saved from examerframe_private.student_response_ratings where response_id = p_response_id;
        if saved is distinct from p_quality then
            raise exception using errcode = 'PT409', message = 'RATING_ALREADY_SUBMITTED';
        end if;
    end if;
    return examerframe_private.student_question(p_participant_id, version_id);
end;
$$;

create function public.save_student_comment(p_participant_id uuid, p_response_id uuid, p_comment text)
returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
    version_id uuid;
    saved text;
    comment_text text := regexp_replace(p_comment, '^[[:space:]]+|[[:space:]]+$', '', 'g');
begin
    perform examerframe_private.require_student(p_participant_id);
    select question_version_id into version_id from examerframe_private.student_responses
    where id = p_response_id and student_id = p_participant_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'RESPONSE_NOT_FOUND';
    end if;
    if comment_text is null or char_length(comment_text) not between 1 and 2000 then
        raise exception using errcode = 'PT400', message = 'INVALID_COMMENT';
    end if;

    insert into examerframe_private.student_response_comments (response_id, comment)
    values (p_response_id, comment_text) on conflict (response_id) do nothing;
    if not found then
        select comment into saved from examerframe_private.student_response_comments where response_id = p_response_id;
        if saved is distinct from comment_text then
            raise exception using errcode = 'PT409', message = 'COMMENT_ALREADY_SUBMITTED';
        end if;
    end if;
    return examerframe_private.student_question(p_participant_id, version_id);
end;
$$;

create function public.get_staff_student_feedback(p_external_id text, p_version_no integer)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
    version_id uuid;
    result jsonb;
begin
    select v.id into version_id
    from public.questions q join public.question_versions v on v.question_id = q.id
    where q.external_id = p_external_id and v.version_no = p_version_no;
    if not found then
        raise exception using errcode = 'PT404', message = 'QUESTION_NOT_FOUND';
    end if;

    with votes as (
        select count(*) filter (where t.quality = 'low') as low_count,
               count(*) filter (where t.quality = 'high') as high_count
        from examerframe_private.student_responses r
        join examerframe_private.student_response_ratings t on t.response_id = r.id
        where r.question_version_id = version_id
    ), opinions as (
        select count(*) as comment_count, coalesce(jsonb_agg(
            jsonb_build_object('text', c.comment, 'submitted_at', c.submitted_at)
            order by c.submitted_at desc, c.response_id
        ), '[]'::jsonb) as comments
        from examerframe_private.student_responses r
        join examerframe_private.student_response_comments c on c.response_id = r.id
        where r.question_version_id = version_id
    ), historical as (
        select source, quality, count(*) as votes
        from public.round_questions rq
        join public.session_questions sq on sq.round_question_id = rq.id
        join public.responses r on r.session_question_id = sq.id
        join public.ratings t on t.response_id = r.id
        where rq.question_version_id = version_id
        group by source, quality
    ), old_counts as (
        select s.source, jsonb_object_agg(q.quality, coalesce(h.votes, 0)) as counts
        from (values ('explicit'), ('default'), ('legacy')) s(source)
        cross join (values ('low'), ('medium'), ('high')) q(quality)
        left join historical h on h.source = s.source and h.quality = q.quality
        group by s.source
    )
    select jsonb_build_object('external_id', p_external_id, 'version_no', p_version_no,
        'low_count', votes.low_count, 'high_count', votes.high_count,
        'comment_count', opinions.comment_count, 'comments', opinions.comments,
        'historical', (select jsonb_object_agg(source, counts) from old_counts))
    into result
    from votes cross join opinions;
    return result;
end;
$$;

revoke all on function public.list_student_responses(uuid, integer, boolean), public.review_student_mistake(uuid, uuid),
    public.submit_student_retry(uuid, uuid, uuid, jsonb), public.save_student_rating(uuid, uuid, text),
    public.save_student_comment(uuid, uuid, text), public.get_staff_student_feedback(text, integer)
from public, anon, authenticated, service_role;
grant execute on function public.list_student_responses(uuid, integer, boolean), public.review_student_mistake(uuid, uuid),
    public.submit_student_retry(uuid, uuid, uuid, jsonb), public.save_student_rating(uuid, uuid, text),
    public.save_student_comment(uuid, uuid, text), public.get_staff_student_feedback(text, integer)
to service_role;
