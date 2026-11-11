-- Stage 7: local abuse prevention for participant writes.
--
-- Every write endpoint that takes a slot through the Edge Function
-- (start or resume, submit an answer, submit a rating) is limited to
-- 60 requests per participant in a fixed 60 second window. The window is
-- anchored at the participant's first request and is not extended by
-- later requests, so a caller cannot keep a window alive forever.
--
-- Only accepted requests are driven through the limiter: the Edge Function
-- consumes a slot after the JWT and the request body are known to be
-- valid, and before the business RPC runs. Reads, including the
-- get-current-question POST, never touch this table.
--
-- The state lives in a private schema with no grants for clients and a
-- single volatile invoker RPC whose single INSERT ... ON CONFLICT statement
-- both counts and decides, so concurrent requests serialize on the row
-- lock and a burst cannot observe a stale count.

create schema examerframe_private;

-- Clients get no access here at all; the Edge Function reaches the table
-- through its SECURITY INVOKER RPC as service_role only.
revoke all privileges on schema examerframe_private
from public, anon, authenticated, service_role;

-- The Edge Function reaches the state through its invoker RPC as service_role,
-- so the role must be able to traverse the schema; everything else stays denied.
grant usage on schema examerframe_private to service_role;

create table examerframe_private.participant_write_limits (
    -- The participant identity comes from the verified Auth JWT. Auth users
    -- are intentionally not referenced, matching public.sessions.
    participant_id uuid primary key,
    window_started_at timestamptz not null,
    requests integer not null,
    constraint participant_write_limits_positive_requests check (requests > 0)
);

comment on table examerframe_private.participant_write_limits is
    'Fixed write-rate window per participant; server-managed only.';

alter table examerframe_private.participant_write_limits enable row level security;

-- Row level security with no policy denies every client path even if a
-- future grant is added by mistake.
revoke all privileges on table examerframe_private.participant_write_limits
from public, anon, authenticated, service_role;
grant select, insert, update on table examerframe_private.participant_write_limits
to service_role;

-- One statement per request. The first request of a window inserts its row
-- with window_started_at taken from clock_timestamp() at execution time; later
-- requests bump the count until the window has expired, at which point the
-- same row restarts at one. The 61st request of a live window is denied
-- without changing its window or count.
--
-- excluded.window_started_at is the single timestamp captured when the VALUES
-- row was built, so every expiry comparison and every reset anchors on the
-- same instant instead of re-reading clock_timestamp() at each call site.
-- A denied attempt inserts no row, so returning the raw INSERT ... RETURNING
-- would yield NULL; wrapping it in a CTE and SELECT EXISTS always returns a
-- real boolean (true when a slot was taken, false when the window denied it).
create function public.take_participant_write_slot(p_participant_id uuid)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
    with attempt as (
        insert into examerframe_private.participant_write_limits as limits (
            participant_id,
            window_started_at,
            requests
        )
        values (p_participant_id, clock_timestamp(), 1)
        on conflict (participant_id) do update
        set window_started_at = case
                when limits.window_started_at + interval '60 seconds'
                    <= excluded.window_started_at
                then excluded.window_started_at
                else limits.window_started_at
            end,
            requests = case
                when limits.window_started_at + interval '60 seconds'
                    <= excluded.window_started_at
                then 1
                else limits.requests + 1
            end
        where limits.window_started_at + interval '60 seconds'
            <= excluded.window_started_at
           or limits.requests < 60
        returning true as accepted
    )
    select exists (select 1 from attempt);
$$;

-- The RPC is server-only; callers must pass the participant ID taken from a
-- verified JWT rather than a value supplied by the browser.
revoke all privileges on function public.take_participant_write_slot(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.take_participant_write_slot(uuid)
to service_role;
