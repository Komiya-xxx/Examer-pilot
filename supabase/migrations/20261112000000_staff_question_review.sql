create table examerframe_private.staff_question_ratings (
    question_version_id uuid primary key references public.question_versions(id) on delete restrict,
    quality text not null check (quality in ('low', 'medium', 'high')),
    submitted_at timestamptz not null default now()
);

alter table examerframe_private.staff_question_ratings enable row level security;
revoke all on table examerframe_private.staff_question_ratings from public, anon, authenticated, service_role;
grant select, insert, update on table examerframe_private.staff_question_ratings to service_role;

create function public.list_staff_review_questions(p_after_external_id text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    with candidates as (
        select q.external_id, v.id as question_version_id, v.version_no, v.stem, v.options,
               feedback.standard_answer, feedback.explanation, rating.quality
        from public.questions as q
        cross join lateral (
            select id, version_no, stem, options
            from public.question_versions
            where question_id = q.id
            order by version_no desc
            limit 1
        ) as v
        left join examerframe_private.question_feedback as feedback on feedback.question_version_id = v.id
        left join examerframe_private.staff_question_ratings as rating on rating.question_version_id = v.id
        where p_after_external_id is null or q.external_id > p_after_external_id
        order by q.external_id
        limit 13
    ), page as (
        select * from candidates order by external_id limit 12
    )
    select jsonb_build_object(
        'questions', coalesce(jsonb_agg(to_jsonb(page) order by external_id), '[]'::jsonb),
        'next_cursor', case when (select count(*) from candidates) > 12 then max(external_id) end
    ) from page;
$$;

create function public.save_staff_question_rating(p_question_version_id uuid, p_quality text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
    if p_quality is null or p_quality not in ('low', 'medium', 'high') then
        raise exception using errcode = 'PT400', message = 'INVALID_QUALITY';
    end if;

    insert into examerframe_private.staff_question_ratings as rating (question_version_id, quality)
    values (p_question_version_id, p_quality)
    on conflict (question_version_id) do update
    set quality = excluded.quality, submitted_at = excluded.submitted_at
    where rating.quality <> excluded.quality;

    return jsonb_build_object('quality', p_quality);
exception when foreign_key_violation then
    raise exception using errcode = 'PT404', message = 'QUESTION_VERSION_NOT_FOUND';
end;
$$;

revoke all on function public.list_staff_review_questions(text) from public, anon, authenticated;
revoke all on function public.save_staff_question_rating(uuid, text) from public, anon, authenticated;
grant execute on function public.list_staff_review_questions(text) to service_role;
grant execute on function public.save_staff_question_rating(uuid, text) to service_role;
