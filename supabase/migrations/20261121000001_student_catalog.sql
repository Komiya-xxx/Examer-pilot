-- Keep the fixed-session tables as the legacy pilot's history. Catalog responses
-- have no assignment dependency and reference the exact published version.
create table examerframe_private.student_responses (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references examerframe_private.student_accounts(id) on delete cascade,
    question_version_id uuid not null references public.question_versions(id) on delete restrict,
    selected_answer jsonb not null,
    correct boolean,
    standard_answer jsonb,
    explanation text,
    submitted_at timestamptz not null default clock_timestamp(),
    reviewed_at timestamptz,
    unique (student_id, question_version_id),
    check ((correct is null) = (standard_answer is null))
);
create index student_responses_by_version on examerframe_private.student_responses (question_version_id);
create index student_responses_by_student on examerframe_private.student_responses (student_id, submitted_at desc, id);

create table examerframe_private.student_response_ratings (
    response_id uuid primary key references examerframe_private.student_responses(id) on delete cascade,
    quality text not null check (quality in ('low', 'high')),
    submitted_at timestamptz not null default clock_timestamp()
);

create table examerframe_private.student_response_comments (
    response_id uuid primary key references examerframe_private.student_responses(id) on delete cascade,
    comment text not null check (comment ~ '[^[:space:]]' and char_length(comment) <= 2000),
    submitted_at timestamptz not null default clock_timestamp()
);

create table examerframe_private.student_retries (
    response_id uuid not null references examerframe_private.student_responses(id) on delete cascade,
    attempt_id uuid not null,
    selected_answer jsonb not null,
    correct boolean not null,
    submitted_at timestamptz not null default clock_timestamp(),
    primary key (response_id, attempt_id)
);

create table examerframe_private.student_positions (
    student_id uuid primary key references examerframe_private.student_accounts(id) on delete cascade,
    question_version_id uuid not null references public.question_versions(id) on delete cascade
);

alter table examerframe_private.student_responses enable row level security;
alter table examerframe_private.student_response_ratings enable row level security;
alter table examerframe_private.student_response_comments enable row level security;
alter table examerframe_private.student_retries enable row level security;
alter table examerframe_private.student_positions enable row level security;
revoke all on examerframe_private.student_responses, examerframe_private.student_response_ratings,
    examerframe_private.student_response_comments, examerframe_private.student_retries,
    examerframe_private.student_positions from public, anon, authenticated, service_role;
grant select, insert on examerframe_private.student_responses, examerframe_private.student_response_ratings,
    examerframe_private.student_response_comments, examerframe_private.student_retries,
    examerframe_private.student_positions to service_role;
grant update (reviewed_at) on examerframe_private.student_responses to service_role;
grant update (question_version_id) on examerframe_private.student_positions to service_role;

create view examerframe_private.student_catalog_versions with (security_invoker = true) as
select q.external_id, v.id as question_version_id, v.stem, v.options
from public.evaluation_rounds batch
join public.round_questions rq on rq.round_id = batch.id
join public.question_versions v on v.id = rq.question_version_id
join public.questions q on q.id = v.question_id
where batch.status = 'open'
    and (batch.starts_at is null or batch.starts_at <= statement_timestamp())
    and (batch.ends_at is null or batch.ends_at > statement_timestamp())
    and rq.is_active and v.review_status = 'published';

revoke all on examerframe_private.student_catalog_versions from public, anon, authenticated, service_role;
grant select on examerframe_private.student_catalog_versions to service_role;

create function examerframe_private.student_question(p_participant_id uuid, p_question_version_id uuid)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
    select jsonb_build_object(
        'external_id', q.external_id, 'question_version_id', v.id, 'version_no', v.version_no,
        'question_type', v.question_type, 'stem', v.stem, 'options', v.options,
        'response', case when r.id is not null then jsonb_build_object(
            'id', r.id, 'selected_answer', r.selected_answer, 'correct', r.correct,
            'standard_answer', r.standard_answer, 'explanation', r.explanation,
            'submitted_at', r.submitted_at, 'reviewed_at', r.reviewed_at,
            'rating', t.quality, 'comment', c.comment, 'retry', latest.result
        ) end
    )
    from public.question_versions v
    join public.questions q on q.id = v.question_id
    left join examerframe_private.student_responses r on r.question_version_id = v.id and r.student_id = p_participant_id
    left join examerframe_private.student_response_ratings t on t.response_id = r.id
    left join examerframe_private.student_response_comments c on c.response_id = r.id
    left join lateral (
        select jsonb_build_object('selected_answer', x.selected_answer, 'correct', x.correct,
                                 'submitted_at', x.submitted_at) as result
        from examerframe_private.student_retries x where x.response_id = r.id
        order by x.submitted_at desc, x.attempt_id desc limit 1
    ) latest on true
    where v.id = p_question_version_id;
$$;

create function public.browse_student_catalog(
    p_participant_id uuid, p_page integer, p_query text, p_external_id text
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
    page_size constant integer := 12;
    search_term text := nullif(lower(regexp_replace(p_query, '^[[:space:]]+|[[:space:]]+$', '', 'g')), '');
    resume_id uuid;
    result jsonb;
begin
    perform examerframe_private.require_student(p_participant_id);
    if p_page < 1 or char_length(p_query) > 200 or char_length(p_external_id) > 200
        or (search_term is not null and p_external_id is not null) then
        raise exception using errcode = 'PT400', message = 'INVALID_REQUEST';
    end if;
    if p_page is null and p_external_id is null and search_term is null then
        select s.question_version_id into resume_id
        from examerframe_private.student_positions s where s.student_id = p_participant_id;
    end if;

    with ranked as (
        select q.*, matched.matched_option,
               row_number() over (order by (lower(q.external_id) = search_term) desc, q.external_id) as position
        from examerframe_private.student_catalog_versions q
        left join lateral (
            select item->>'text' as matched_option
            from jsonb_array_elements(q.options) with ordinality option(item, position)
            where search_term is not null and strpos(lower(item->>'text'), search_term) > 0
            order by option.position limit 1
        ) matched on true
        where search_term is null or strpos(lower(q.external_id), search_term) > 0
            or strpos(lower(q.stem), search_term) > 0 or matched.matched_option is not null
    ), totals as (
        select count(*) as total_count, (count(*) + page_size - 1) / page_size as total_pages,
               max(position) filter (where external_id = p_external_id or question_version_id = resume_id) as target_position,
               max(question_version_id::text) filter (
                   where external_id = p_external_id or question_version_id = resume_id
               ) as focus_version_id
        from ranked
    ), pagination as (
        select totals.*, coalesce((target_position - 1) / page_size + 1,
            greatest(1, least(coalesce(p_page, 1), total_pages))) as page
        from totals
    ), displayed as materialized (
        select r.* from ranked r cross join pagination p
        where r.position between (p.page - 1) * page_size + 1 and p.page * page_size
    )
    select jsonb_build_object('page', p.page, 'total_count', p.total_count, 'total_pages', p.total_pages,
        'focus_version_id', p.focus_version_id,
        'questions', coalesce((select jsonb_agg(
            examerframe_private.student_question(p_participant_id, d.question_version_id) order by d.position
        ) from displayed d where search_term is null), '[]'::jsonb),
        'matches', coalesce((select jsonb_agg(
            jsonb_build_object('external_id', d.external_id, 'stem', d.stem, 'matched_option', d.matched_option)
            order by d.position
        ) from displayed d where search_term is not null), '[]'::jsonb)
    ) into result
    from pagination p where p_external_id is null or p.target_position is not null;
    if result is null then
        raise exception using errcode = 'PT404', message = 'QUESTION_NOT_FOUND';
    end if;
    return result;
end;
$$;

create function public.save_student_position(p_participant_id uuid, p_question_version_id uuid)
returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
begin
    perform examerframe_private.require_student(p_participant_id);
    insert into examerframe_private.student_positions (student_id, question_version_id)
    select p_participant_id, v.question_version_id from examerframe_private.student_catalog_versions v
    where v.question_version_id = p_question_version_id
    on conflict (student_id) do update set question_version_id = excluded.question_version_id;
    if not found then
        raise exception using errcode = 'PT404', message = 'QUESTION_NOT_FOUND';
    end if;
    return jsonb_build_object('question_version_id', p_question_version_id);
end;
$$;

create function public.submit_student_answer(p_participant_id uuid, p_question_version_id uuid, p_answer jsonb)
returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
    saved jsonb;
    normalized jsonb;
    standard jsonb;
    notes text;
    version public.question_versions%rowtype;
begin
    perform examerframe_private.require_student(p_participant_id);
    select selected_answer into saved from examerframe_private.student_responses
    where student_id = p_participant_id and question_version_id = p_question_version_id;

    select v.* into version from public.question_versions v
    where v.id = p_question_version_id and (saved is not null or exists (
        select 1 from examerframe_private.student_catalog_versions where question_version_id = v.id
    ));
    if not found then
        raise exception using errcode = 'PT404', message = 'QUESTION_NOT_FOUND';
    end if;
    normalized := public.normalize_review_answer(version.question_type, version.options, p_answer);

    if saved is null then
        select f.standard_answer, f.explanation into standard, notes
        from examerframe_private.question_feedback f where f.question_version_id = version.id;
        if standard is not null then
            begin
                standard := public.normalize_review_answer(version.question_type, version.options, standard);
            exception when sqlstate 'PT400' then
                standard := null;
            end;
        end if;

        insert into examerframe_private.student_responses (
            student_id, question_version_id, selected_answer, correct, standard_answer, explanation
        ) values (p_participant_id, version.id, normalized, normalized = standard, standard, notes)
        on conflict (student_id, question_version_id) do nothing;
        if found then
            insert into examerframe_private.student_positions (student_id, question_version_id)
            values (p_participant_id, version.id)
            on conflict (student_id) do update set question_version_id = excluded.question_version_id;
            saved := normalized;
        else
            select selected_answer into saved from examerframe_private.student_responses
            where student_id = p_participant_id and question_version_id = version.id;
        end if;
    end if;

    if saved is distinct from normalized then
        raise exception using errcode = 'PT409', message = 'ANSWER_ALREADY_SUBMITTED';
    end if;
    return examerframe_private.student_question(p_participant_id, version.id);
end;
$$;

revoke all on function examerframe_private.student_question(uuid, uuid),
    public.browse_student_catalog(uuid, integer, text, text), public.save_student_position(uuid, uuid),
    public.submit_student_answer(uuid, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function examerframe_private.student_question(uuid, uuid),
    public.browse_student_catalog(uuid, integer, text, text), public.save_student_position(uuid, uuid),
    public.submit_student_answer(uuid, uuid, jsonb)
to service_role;
