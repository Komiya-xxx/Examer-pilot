begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

-- Grants and shape.

select ok(
    not has_function_privilege('anon', 'public.take_participant_write_slot(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.take_participant_write_slot(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.take_participant_write_slot(uuid)', 'execute'),
    'Only the server role can take a participant write slot'
);

select ok(
    not exists (
        select 1
          from pg_proc as procedure
          cross join lateral aclexplode(
              coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) as privilege
         where procedure.oid = 'public.take_participant_write_slot(uuid)'::regprocedure
           and privilege.grantee = 0
           and privilege.privilege_type = 'EXECUTE'
    ),
    'The limiter RPC keeps no default PUBLIC execute grant'
);

select is(
    (select procedure.provolatile::text
       from pg_proc as procedure
      where procedure.oid = 'public.take_participant_write_slot(uuid)'::regprocedure),
    'v',
    'The limiter RPC is volatile'
);

select is(
    (select procedure.prosecdef
       from pg_proc as procedure
      where procedure.oid = 'public.take_participant_write_slot(uuid)'::regprocedure),
    false,
    'The limiter RPC is an invoker, not a definer'
);

select is(
    (select array_to_string(procedure.proconfig, ',')
       from pg_proc as procedure
      where procedure.oid = 'public.take_participant_write_slot(uuid)'::regprocedure),
    'search_path=""',
    'The limiter RPC pins an empty search_path'
);

select is(
    (select pg_get_function_result('public.take_participant_write_slot(uuid)'::regprocedure)),
    'boolean',
    'The limiter RPC returns a boolean'
);

select ok(
    exists (select 1 from pg_namespace where nspname = 'examerframe_private'),
    'The limiter state lives in the private schema'
);

select ok(
    not has_schema_privilege('anon', 'examerframe_private', 'usage')
    and not has_schema_privilege('authenticated', 'examerframe_private', 'usage')
    and has_schema_privilege('service_role', 'examerframe_private', 'usage'),
    'Only the server role can use the private schema'
);

select ok(
    not has_table_privilege('anon', 'examerframe_private.participant_write_limits', 'select')
    and not has_table_privilege('authenticated', 'examerframe_private.participant_write_limits', 'select')
    and not has_table_privilege('anon', 'examerframe_private.participant_write_limits', 'insert')
    and not has_table_privilege('authenticated', 'examerframe_private.participant_write_limits', 'update')
    and has_table_privilege('service_role', 'examerframe_private.participant_write_limits', 'select')
    and has_table_privilege('service_role', 'examerframe_private.participant_write_limits', 'insert')
    and has_table_privilege('service_role', 'examerframe_private.participant_write_limits', 'update'),
    'Only the server role can read or write write-limit rows'
);

select ok(
    not exists (
        select 1
          from pg_class as relation
          cross join lateral aclexplode(
              coalesce(relation.relacl, acldefault('r', relation.relowner))
          ) as privilege
         where relation.oid = 'examerframe_private.participant_write_limits'::regclass
           and privilege.grantee = 0
    ),
    'The write-limit table keeps no default PUBLIC privileges'
);

select ok(
    (select relation.relrowsecurity
       from pg_class as relation
      where relation.oid = 'examerframe_private.participant_write_limits'::regclass),
    'The write-limit table has row level security'
);

select is(
    (select array_agg(attribute.attname::text order by attribute.attnum)
       from pg_attribute as attribute
      where attribute.attrelid = 'examerframe_private.participant_write_limits'::regclass
        and attribute.attnum > 0
        and not attribute.attisdropped),
    array['participant_id', 'window_started_at', 'requests'],
    'The write-limit table has the documented columns'
);

select is(
    (select array_agg(constraint_row.conname::text)
       from pg_constraint as constraint_row
      where constraint_row.conrelid = 'examerframe_private.participant_write_limits'::regclass
        and constraint_row.contype = 'p'),
    array['participant_write_limits_pkey'],
    'The participant ID is the primary key, so every participant has one row'
);

select ok(
    not exists (
        select 1
          from pg_constraint as constraint_row
         where constraint_row.conrelid = 'examerframe_private.participant_write_limits'::regclass
           and constraint_row.contype = 'f'
    ),
    'Write-limit rows do not reference Auth or study tables'
);

-- Cutoff, reset and isolation. The limiter RPC is server-only, so the fixtures
-- are driven as service_role, the same role the Edge Function uses.

set local role service_role;

select is(
    (select count(*) from public.take_participant_write_slot(gen_random_uuid())),
    1::bigint,
    'A fresh participant receives a slot'
);

select is(
    public.take_participant_write_slot('11111111-1111-4111-8111-111111111111'),
    true,
    'The first attempt of a participant is accepted'
);

select is(
    (select limits.requests
       from examerframe_private.participant_write_limits as limits
      where limits.participant_id = '11111111-1111-4111-8111-111111111111'),
    1,
    'The first attempt opens the window with one request'
);

-- Fill the window to exactly 60 accepted attempts in one burst.
with fills as (
    select public.take_participant_write_slot('11111111-1111-4111-8111-111111111111') as accepted
    from generate_series(1, 59)
)
select is(
    (select count(*) from fills where accepted),
    59::bigint,
    'Attempts 2 to 60 are all accepted'
);

select is(
    (select limits.requests
       from examerframe_private.participant_write_limits as limits
      where limits.participant_id = '11111111-1111-4111-8111-111111111111'),
    60,
    'Sixty accepted attempts record sixty requests'
);

select is(
    public.take_participant_write_slot('11111111-1111-4111-8111-111111111111'),
    false,
    'The 61st attempt in the window is denied'
);

select is(
    (select limits.requests
       from examerframe_private.participant_write_limits as limits
      where limits.participant_id = '11111111-1111-4111-8111-111111111111'),
    60,
    'A denied attempt does not change the count'
);

-- An independent participant is unaffected by the saturated one.
select is(
    public.take_participant_write_slot('22222222-2222-4222-8222-222222222222'),
    true,
    'Another participant is independent of a saturated window'
);

-- The window is fixed: it does not slide with each request.
select ok(
    (select clock_timestamp() - (
                select limits.window_started_at
                  from examerframe_private.participant_write_limits as limits
                 where limits.participant_id = '22222222-2222-4222-8222-222222222222'
            ) < interval '10 seconds'),
    'clock_timestamp captured the window start at insertion time'
);

update examerframe_private.participant_write_limits
set window_started_at = window_started_at - interval '61 seconds'
where participant_id = '11111111-1111-4111-8111-111111111111';

select is(
    public.take_participant_write_slot('11111111-1111-4111-8111-111111111111'),
    true,
    'An expired window accepts the next attempt'
);

select ok(
    (select limits.requests = 1
            and limits.window_started_at > clock_timestamp() - interval '10 seconds'
       from examerframe_private.participant_write_limits as limits
      where limits.participant_id = '11111111-1111-4111-8111-111111111111'),
    'An expired window restarts the count and re-anchors the start'
);

-- Within the reset window the 60-attempt allowance applies again in full.
with fills as (
    select public.take_participant_write_slot('11111111-1111-4111-8111-111111111111') as accepted
    from generate_series(1, 59)
)
select is(
    (select count(*) from fills where accepted),
    59::bigint,
    'The reset window accepts sixty attempts again'
);

select is(
    public.take_participant_write_slot('11111111-1111-4111-8111-111111111111'),
    false,
    'The reset window is exhausted at the 61st attempt'
);

-- A window that expired with 60 requests still grants a fresh window.
update examerframe_private.participant_write_limits
set window_started_at = window_started_at - interval '120 seconds'
where participant_id = '22222222-2222-4222-8222-222222222222';

select is(
    public.take_participant_write_slot('22222222-2222-4222-8222-222222222222'),
    true,
    'A long-since expired window starts over'
);

-- The business RPCs stay service-role only and are unaffected by the limiter.
select ok(
    has_function_privilege('service_role', 'public.start_or_resume_session_for_participant(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.submit_answer_for_participant(uuid, uuid, uuid, jsonb)', 'execute')
    and has_function_privilege('service_role', 'public.submit_rating_for_participant(uuid, uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.start_or_resume_session_for_participant(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.submit_answer_for_participant(uuid, uuid, uuid, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.submit_rating_for_participant(uuid, uuid, text)', 'execute'),
    'The limited write RPCs remain server-only'
);

reset role;

-- Client roles cannot reach the state or the RPC at all.

set local role authenticated;

select throws_ok(
    $$ select public.take_participant_write_slot('11111111-1111-4111-8111-111111111111') $$,
    '42501',
    null,
    'An authenticated client cannot take write slots directly'
);

select throws_ok(
    $$ select count(*) from examerframe_private.participant_write_limits $$,
    '42501',
    null,
    'An authenticated client cannot read write-limit rows'
);

reset role;

select * from finish();
rollback;
