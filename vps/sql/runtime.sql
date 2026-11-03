create table svitlo_vps.sessions (
 token_hash text primary key check(length(token_hash)=64), owner uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(), expires_at timestamptz not null
);
create index sessions_expiry on svitlo_vps.sessions(expires_at);
create table svitlo_vps.release_state(id boolean primary key default true check(id),schema_version integer not null,delivery_mode text not null check(delivery_mode='disabled'));
insert into svitlo_vps.release_state values(true,1,'disabled');
grant usage on schema public,auth to svitlo_stage_api,svitlo_stage_worker;
grant execute on function auth.uid() to svitlo_stage_api;
grant select,insert,update,delete on all tables in schema public to svitlo_stage_api,svitlo_stage_worker;
grant usage,select on all sequences in schema public to svitlo_stage_api,svitlo_stage_worker;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on all functions in schema public to svitlo_stage_api,svitlo_stage_worker;
-- The API role cannot bypass owner filtering even if an application predicate is missed.
do $$ declare t record; predicate text; begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'svitlo_%' loop
  predicate := case
   when t.tablename in ('svitlo_profiles','svitlo_subscriptions','svitlo_limits','svitlo_previews') then 'owner=auth.uid()'
   when t.tablename='svitlo_deliveries' then 'exists(select 1 from public.svitlo_profiles p where p.id=profile_id and p.owner=auth.uid())'
   else 'true' end;
  execute format('alter table public.%I enable row level security',t.tablename);
  execute format('create policy stage_server on public.%I to svitlo_stage_api using (%s) with check (%s)',t.tablename,predicate,predicate);
 end loop;
end $$;
grant usage on schema svitlo_vps to svitlo_stage_api,svitlo_stage_session,svitlo_stage_worker;
grant select on svitlo_vps.release_state,svitlo_vps.migrations to svitlo_stage_api,svitlo_stage_worker;
grant usage on schema auth to svitlo_stage_session;
grant select,insert,delete on auth.users to svitlo_stage_session;
grant select,insert,update,delete on svitlo_vps.sessions to svitlo_stage_session;
grant usage on schema svitlo_internal to svitlo_stage_worker;
grant execute on function svitlo_internal.maintenance(bigint) to svitlo_stage_worker;
grant select,update on svitlo_internal.scheduler to svitlo_stage_worker;
revoke all on schema svitlo_internal from svitlo_stage_api;
-- Worker alone performs bounded cleanup; no cron/net/Vault or production HTTP scheduler.
