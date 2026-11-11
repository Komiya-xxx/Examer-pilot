create table public.questions (
    id uuid primary key default gen_random_uuid(),
    external_id text not null unique,
    created_at timestamptz not null default now(),
    constraint questions_external_id_nonblank check (external_id ~ '[^[:space:]]')
);

create table public.question_versions (
    id uuid primary key default gen_random_uuid(),
    question_id uuid not null references public.questions (id) on delete restrict,
    version_no integer not null,
    question_type text not null,
    stem text not null,
    options jsonb not null,
    review_status text not null default 'draft',
    created_at timestamptz not null default now(),
    unique (question_id, version_no),
    unique (id, question_id),
    unique (id, review_status),
    constraint question_versions_positive_version_no check (version_no > 0),
    constraint question_versions_question_type check (
        question_type in ('single_choice', 'multiple_choice', 'true_false')
    ),
    constraint question_versions_stem_nonblank check (stem ~ '[^[:space:]]'),
    constraint question_versions_options_shape check (
        case
            when jsonb_typeof(options) <> 'array' then false
            when question_type = 'true_false' then jsonb_array_length(options) = 0
            else jsonb_array_length(options) >= 2
        end
    ),
    constraint question_versions_review_status check (
        review_status in ('draft', 'published', 'retired')
    )
);

create function public.preserve_published_question_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if old.review_status in ('published', 'retired')
        and row(new.id, new.question_id, new.version_no, new.question_type, new.stem, new.options, new.created_at)
            is distinct from
            row(old.id, old.question_id, old.version_no, old.question_type, old.stem, old.options, old.created_at)
    then
        raise exception using
            errcode = 'check_violation',
            message = 'Create a new version to change published question content.';
    end if;

    if (old.review_status = 'published' and new.review_status = 'draft')
        or (old.review_status = 'retired' and new.review_status <> 'retired')
    then
        raise exception using
            errcode = 'check_violation',
            message = 'A published or retired question version cannot return to an earlier status.';
    end if;

    return new;
end;
$$;

create trigger preserve_published_question_version
before update on public.question_versions
for each row execute function public.preserve_published_question_version();

revoke all privileges on function public.preserve_published_question_version()
    from public, anon, authenticated, service_role;

create table public.evaluation_rounds (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique,
    title text not null,
    description text not null default '',
    status text not null default 'draft',
    questions_per_session integer not null default 10,
    starts_at timestamptz,
    ends_at timestamptz,
    created_at timestamptz not null default now(),
    constraint evaluation_rounds_slug_nonblank check (slug ~ '[^[:space:]]'),
    constraint evaluation_rounds_title_nonblank check (title ~ '[^[:space:]]'),
    constraint evaluation_rounds_status check (status in ('draft', 'open', 'closed')),
    constraint evaluation_rounds_positive_question_count check (questions_per_session > 0),
    constraint evaluation_rounds_valid_window check (ends_at > starts_at)
);

create unique index evaluation_rounds_one_open_idx
    on public.evaluation_rounds (status)
    where status = 'open';

create table public.round_questions (
    id uuid primary key default gen_random_uuid(),
    round_id uuid not null references public.evaluation_rounds (id) on delete restrict,
    question_version_id uuid not null,
    question_id uuid not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    -- A null status lets inactive associations retain their historical version.
    required_review_status text generated always as (
        case when is_active then 'published'::text end
    ) stored,
    unique (round_id, question_version_id),
    unique (id, round_id, question_id),
    constraint round_questions_version_identity_fk
        foreign key (question_version_id, question_id)
        references public.question_versions (id, question_id) on update restrict on delete restrict,
    constraint round_questions_active_version_fk
        foreign key (question_version_id, required_review_status)
        references public.question_versions (id, review_status) on update restrict on delete restrict
);

create unique index round_questions_one_active_version_idx
    on public.round_questions (round_id, question_id)
    where is_active;

create index round_questions_round_active_idx
    on public.round_questions (round_id, is_active);

create index round_questions_version_idx
    on public.round_questions (question_version_id);

create table public.sessions (
    id uuid primary key default gen_random_uuid(),
    round_id uuid not null references public.evaluation_rounds (id) on delete restrict,
    -- The server obtains this UUID from Auth. Removing an Auth user does not
    -- delete study data or prevent account cleanup.
    participant_id uuid not null,
    status text not null default 'in_progress',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (round_id, participant_id),
    unique (id, round_id),
    constraint sessions_status check (status in ('in_progress', 'completed')),
    constraint sessions_completion_time check (
        (status = 'completed') = (completed_at is not null)
        and (completed_at is null or completed_at >= started_at)
    )
);

create index sessions_round_status_started_at_idx
    on public.sessions (round_id, status, started_at);

create table public.session_questions (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null,
    round_question_id uuid not null,
    -- Both FKs share round_id; question_id also identifies duplicates across versions.
    round_id uuid not null,
    question_id uuid not null,
    position integer not null,
    assigned_at timestamptz not null default now(),
    unique (session_id, round_question_id),
    unique (session_id, position),
    unique (session_id, question_id),
    constraint session_questions_positive_position check (position > 0),
    constraint session_questions_session_round_fk
        foreign key (session_id, round_id)
        references public.sessions (id, round_id) on update restrict on delete restrict,
    constraint session_questions_round_question_identity_fk
        foreign key (round_question_id, round_id, question_id)
        references public.round_questions (id, round_id, question_id) on update restrict on delete restrict
);

create index session_questions_round_question_idx
    on public.session_questions (round_question_id);

create table public.responses (
    id uuid primary key default gen_random_uuid(),
    session_question_id uuid not null unique references public.session_questions (id) on delete restrict,
    selected_answer jsonb not null,
    submitted_at timestamptz not null default now(),
    constraint responses_answer_json_type check (
        jsonb_typeof(selected_answer) in ('string', 'array', 'boolean')
    )
);

create table public.ratings (
    id uuid primary key default gen_random_uuid(),
    response_id uuid not null unique references public.responses (id) on delete restrict,
    quality text not null,
    submitted_at timestamptz not null default now(),
    constraint ratings_quality check (quality in ('low', 'medium', 'high'))
);

alter table public.questions enable row level security;
alter table public.question_versions enable row level security;
alter table public.evaluation_rounds enable row level security;
alter table public.round_questions enable row level security;
alter table public.sessions enable row level security;
alter table public.session_questions enable row level security;
alter table public.responses enable row level security;
alter table public.ratings enable row level security;

-- Reset Supabase's default grants for these tables before granting trusted writes.
revoke all privileges on table
    public.questions,
    public.question_versions,
    public.evaluation_rounds,
    public.round_questions,
    public.sessions,
    public.session_questions,
    public.responses,
    public.ratings
from public, anon, authenticated, service_role;

grant usage on schema public to service_role;

grant select, insert on table
    public.questions,
    public.question_versions,
    public.evaluation_rounds,
    public.round_questions,
    public.sessions,
    public.session_questions,
    public.responses,
    public.ratings
to service_role;

grant update (question_type, stem, options, review_status) on public.question_versions to service_role;
grant update (title, description, status, questions_per_session, starts_at, ends_at)
    on public.evaluation_rounds to service_role;
grant update (is_active) on public.round_questions to service_role;
grant update (status, completed_at) on public.sessions to service_role;
