create function public.browse_staff_review_questions(
    p_page integer default 1,
    p_query text default null,
    p_external_id text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    v_page_size constant integer := 12;
    v_query text := nullif(lower(regexp_replace(p_query, '^[[:space:]]+|[[:space:]]+$', '', 'g')), '');
    v_result jsonb;
begin
    if p_page is null or p_page < 1 or length(p_query) > 200
        or (v_query is not null and p_external_id is not null) then
        raise exception using errcode = 'PT400', message = 'INVALID_STAFF_REVIEW_NAVIGATION';
    end if;

    with ranked as (
        select q.external_id, v.id as question_version_id, v.version_no, v.review_status, v.stem, v.options,
               matched.option_text as matched_option,
               row_number() over (order by (lower(q.external_id) = v_query) desc, q.external_id) as position
        from public.questions as q
        cross join lateral (
            select id, version_no, review_status, stem, options
            from public.question_versions
            where question_id = q.id
            order by version_no desc
            limit 1
        ) as v
        left join lateral (
            select item ->> 'text' as option_text
            from jsonb_array_elements(v.options) with ordinality as option(item, position)
            where v_query is not null and strpos(lower(item ->> 'text'), v_query) > 0
            order by option.position
            limit 1
        ) as matched on true
        where v.review_status <> 'retired'
          and (v_query is null or strpos(lower(q.external_id), v_query) > 0
               or strpos(lower(v.stem), v_query) > 0 or matched.option_text is not null)
    ), totals as (
        select count(*) as total_count, (count(*) + v_page_size - 1) / v_page_size as total_pages,
               max(position) filter (where external_id = p_external_id) as target_position
        from ranked
    ), pagination as (
        select total_count, total_pages, target_position,
               case when p_external_id is not null then (target_position - 1) / v_page_size + 1
                    else greatest(1, least(p_page, total_pages)) end as page
        from totals
    ), display_page as materialized (
        select r.* from ranked as r cross join pagination as p
        where r.position between (p.page - 1) * v_page_size + 1 and p.page * v_page_size
    ), questions as (
        select q.external_id, q.question_version_id, q.version_no, q.stem, q.options,
               feedback.standard_answer, coalesce(feedback.explanation, notes.explanation) as explanation,
               rating.quality
        from display_page as q
        left join examerframe_private.question_feedback as feedback on feedback.question_version_id = q.question_version_id
        left join examerframe_private.question_review_notes as notes
          on notes.question_version_id = q.question_version_id and q.review_status = 'draft'
        left join examerframe_private.staff_question_ratings as rating on rating.question_version_id = q.question_version_id
        where v_query is null
    ), matches as (
        select external_id, stem, matched_option
        from display_page
        where v_query is not null
    )
    select jsonb_build_object(
        'page', p.page,
        'total_pages', p.total_pages,
        'total_count', p.total_count,
        'questions', coalesce((select jsonb_agg(to_jsonb(q) order by q.external_id) from questions as q), '[]'::jsonb),
        'matches', coalesce((
            select jsonb_agg(to_jsonb(m) order by (lower(m.external_id) = v_query) desc, m.external_id)
            from matches as m
        ), '[]'::jsonb)
    ) into v_result
    from pagination as p
    where p_external_id is null or p.target_position is not null;

    if v_result is null then
        raise exception using errcode = 'PT404', message = 'QUESTION_NOT_FOUND';
    end if;
    return v_result;
end;
$$;

revoke all on function public.browse_staff_review_questions(integer, text, text) from public, anon, authenticated;
grant execute on function public.browse_staff_review_questions(integer, text, text) to service_role;
