-- ARCH-MOD-01-01. Progress, liveness and evidence freshness are separate clocks.
create table svitlo_events.consumer_state(
 id boolean primary key default true check(id),last_attempt_at timestamptz,
 last_cycle_at timestamptz,last_progress_at timestamptz,last_failure_at timestamptz,error_code text
);
alter table svitlo_events.consumer_state owner to svitlo_events_owner;
insert into svitlo_events.consumer_state(id) values(true);
revoke all on svitlo_events.consumer_state from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session;
create function svitlo_events.cycle(outcome text,completed integer default 0) returns void
language plpgsql security definer set search_path='' as $$
begin
 if outcome not in ('attempt','ok','failure') or completed is null or completed not between 0 and 20 then raise exception 'invalid consumer status';end if;
 update svitlo_events.consumer_state set last_attempt_at=case when outcome='attempt' then clock_timestamp() else last_attempt_at end,
  last_cycle_at=case when outcome='ok' then clock_timestamp() else last_cycle_at end,
  last_progress_at=case when outcome='ok' and completed>0 then clock_timestamp() else last_progress_at end,
  last_failure_at=case when outcome='failure' then clock_timestamp() else last_failure_at end,
  error_code=case when outcome='failure' then 'projector_error' when outcome='ok' then null else error_code end where id;
end $$;
alter function svitlo_events.cycle(text,integer) owner to svitlo_events_owner;
revoke all on function svitlo_events.cycle(text,integer) from public;
grant execute on function svitlo_events.cycle(text,integer) to svitlo_stage_worker;
create index modular_dead_count on svitlo_events.jobs(state) where state='dead';
create function svitlo_events.summary() returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('generatedSeconds',extract(epoch from clock_timestamp()),
  'jobs',(select coalesce(jsonb_object_agg(state,n),'{}'::jsonb) from
   (select state,count(*) n from svitlo_events.jobs where state in ('ready','running','dead') group by state) x),
  'oldestPendingSeconds',(select greatest(0,extract(epoch from clock_timestamp()-min(created_at))) from svitlo_events.jobs where state in ('ready','running')),
  'lastCycleSeconds',(select extract(epoch from last_cycle_at) from svitlo_events.consumer_state where id),
  'lastProgressSeconds',(select extract(epoch from last_progress_at) from svitlo_events.consumer_state where id));
$$;
alter function svitlo_events.summary() owner to svitlo_events_owner;
revoke all on function svitlo_events.summary() from public;
grant usage on schema svitlo_events to svitlo_stage_api;
grant execute on function svitlo_events.summary() to svitlo_stage_api,svitlo_stage_worker;
-- The API can read aggregate metadata, never entity IDs, jobs or consumer writes.
