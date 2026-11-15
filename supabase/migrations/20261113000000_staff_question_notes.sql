-- Review notes may describe a conditional or unresolved key. Keep them out of
-- the answer table used to grade participant responses.
create table examerframe_private.question_review_notes (
    question_version_id uuid primary key references public.question_versions(id) on delete restrict,
    explanation text not null check (length(btrim(explanation)) > 0)
);

alter table examerframe_private.question_review_notes enable row level security;
revoke all on table examerframe_private.question_review_notes from public, anon, authenticated, service_role;
grant select on table examerframe_private.question_review_notes to service_role;

create or replace function public.list_staff_review_questions(p_after_external_id text default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    with candidates as (
        select q.external_id, v.id as question_version_id, v.version_no, v.stem, v.options,
               feedback.standard_answer, coalesce(feedback.explanation, notes.explanation) as explanation,
               rating.quality
        from public.questions as q
        cross join lateral (
            select id, version_no, stem, options, review_status
            from public.question_versions
            where question_id = q.id
            order by version_no desc
            limit 1
        ) as v
        left join examerframe_private.question_feedback as feedback on feedback.question_version_id = v.id
        left join examerframe_private.question_review_notes as notes
            on notes.question_version_id = v.id and v.review_status = 'draft'
        left join examerframe_private.staff_question_ratings as rating on rating.question_version_id = v.id
        where (p_after_external_id is null or q.external_id > p_after_external_id)
          and v.review_status <> 'retired'
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

revoke all on function public.list_staff_review_questions(text) from public, anon, authenticated;
grant execute on function public.list_staff_review_questions(text) to service_role;
