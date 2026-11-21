create table examerframe_private.student_accounts (
    id uuid primary key references auth.users(id) on delete cascade,
    username text not null unique check (char_length(username) between 3 and 32)
);

alter table examerframe_private.student_accounts enable row level security;
revoke all on examerframe_private.student_accounts from public, anon, authenticated, service_role;
grant select on examerframe_private.student_accounts to service_role;

-- Only Auth's Admin API can set app metadata. GoTrue writes it after the initial
-- insert in the same transaction, so either both registration writes commit or
-- neither does.
create function examerframe_private.bind_new_student_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.is_anonymous is false and new.raw_app_meta_data ? 'examerframe_username' then
        insert into examerframe_private.student_accounts (id, username)
        values (new.id, new.raw_app_meta_data->>'examerframe_username')
        on conflict (id) do nothing;
    end if;
    return new;
end;
$$;

revoke all on function examerframe_private.bind_new_student_account() from public, anon, authenticated, service_role;
create trigger examerframe_bind_student_account after insert or update of raw_app_meta_data on auth.users
for each row execute function examerframe_private.bind_new_student_account();

create function examerframe_private.require_student(p_participant_id uuid)
returns text
language plpgsql stable security invoker set search_path = ''
as $$
declare
    account_name text;
begin
    select username into account_name from examerframe_private.student_accounts where id = p_participant_id;
    if not found then
        raise exception using errcode = 'PT403', message = 'STUDENT_ACCOUNT_REQUIRED';
    end if;
    return account_name;
end;
$$;

create function public.get_student_profile(p_participant_id uuid)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
    select jsonb_build_object('id', p_participant_id, 'username', examerframe_private.require_student(p_participant_id));
$$;

-- Limit Auth administration independently of password login. No client address,
-- username or password is collected by this single shared registration window.
create table examerframe_private.student_signup_window (
    singleton boolean primary key check (singleton),
    opened_at timestamptz not null,
    attempts integer not null check (attempts > 0)
);

alter table examerframe_private.student_signup_window enable row level security;
revoke all on examerframe_private.student_signup_window from public, anon, authenticated, service_role;
grant select, insert, update on examerframe_private.student_signup_window to service_role;

create function public.take_student_signup_slot()
returns boolean
language sql volatile security invoker set search_path = ''
as $$
    with slot as (
        insert into examerframe_private.student_signup_window as w (singleton, opened_at, attempts)
        values (true, clock_timestamp(), 1)
        on conflict (singleton) do update
        set opened_at = case when w.opened_at + interval '60 seconds' <= excluded.opened_at
                              then excluded.opened_at else w.opened_at end,
            attempts = case when w.opened_at + interval '60 seconds' <= excluded.opened_at
                            then 1 else w.attempts + 1 end
        where w.opened_at + interval '60 seconds' <= excluded.opened_at or w.attempts < 30
        returning true
    )
    select exists (select 1 from slot);
$$;

-- Existing write-rate records intentionally have no Auth foreign key. Remove the
-- new account's slot on deletion while preserving the legacy pilot's history.
create function examerframe_private.clear_student_write_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
    delete from examerframe_private.participant_write_limits where participant_id = old.id;
    return old;
end;
$$;

revoke all on function examerframe_private.clear_student_write_limit() from public, anon, authenticated, service_role;
create trigger examerframe_clear_student_write_limit after delete on examerframe_private.student_accounts
for each row execute function examerframe_private.clear_student_write_limit();

revoke all on function examerframe_private.require_student(uuid), public.get_student_profile(uuid),
    public.take_student_signup_slot() from public, anon, authenticated, service_role;
grant execute on function examerframe_private.require_student(uuid), public.get_student_profile(uuid),
    public.take_student_signup_slot() to service_role;
