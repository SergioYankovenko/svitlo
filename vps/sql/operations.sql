-- ARC-05: independent receipt/history horizons and a whole-worker-cycle heartbeat.
create table svitlo_vps.worker_cycle (
 id boolean primary key default true check(id), last_attempt timestamptz,
 last_success timestamptz, last_failure timestamptz, error_code text check(length(error_code)<=32)
);
insert into svitlo_vps.worker_cycle(id) values(true);
alter table svitlo_vps.worker_cycle enable row level security;
revoke all on svitlo_vps.worker_cycle from public,anon,authenticated,svitlo_stage_api,svitlo_stage_session;
grant select,update on svitlo_vps.worker_cycle to svitlo_stage_worker;

create function svitlo_sensors.retention_policy() returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('historyDays',90,'offlineReplayDays',90,'receiptDays',91,'bootDays',91,
  'cleanupBatch',1000,'receiptPayload','identity_sequence_hash_outcome_only','historySource','explicit_coalesced_ranges');
$$;
alter function svitlo_sensors.retention_policy() owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.retention_policy() from public;
grant execute on function svitlo_sensors.retention_policy() to svitlo_stage_worker;

create or replace function svitlo_sensors.phone_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare r integer;h integer;b integer;d integer;p jsonb:=svitlo_sensors.retention_policy();begin
 -- Receipt grace covers the entire accepted replay horizon, even at its boundary.
 delete from svitlo_sensors.phone_receipts where (binding_id,stream_id,event_id) in
  (select binding_id,stream_id,event_id from svitlo_sensors.phone_receipts
   where received_at<now()-make_interval(days=>(p->>'receiptDays')::int) order by received_at
   limit (p->>'cleanupBatch')::int for update skip locked);get diagnostics r=row_count;
 delete from svitlo_sensors.phone_ranges where range_id in
  (select range_id from svitlo_sensors.phone_ranges where end_at<now()-make_interval(days=>(p->>'historyDays')::int)
   order by end_at limit (p->>'cleanupBatch')::int for update skip locked);get diagnostics h=row_count;
 update svitlo_sensors.phone_ranges set start_at=now()-make_interval(days=>(p->>'historyDays')::int) where range_id in
  (select range_id from svitlo_sensors.phone_ranges where start_at<now()-make_interval(days=>(p->>'historyDays')::int)
   and end_at>=now()-make_interval(days=>(p->>'historyDays')::int) limit (p->>'cleanupBatch')::int for update skip locked);
 delete from svitlo_sensors.phone_boots where (binding_id,stream_id,boot_id) in
  (select binding_id,stream_id,boot_id from svitlo_sensors.phone_boots where created_at<now()-make_interval(days=>(p->>'bootDays')::int)
   order by created_at limit (p->>'cleanupBatch')::int for update skip locked);get diagnostics b=row_count;
 delete from svitlo_sensors.devices where sensor_id in
  (select d.sensor_id from svitlo_sensors.devices d join svitlo_sensors.phone_devices f using(sensor_id)
   where d.status='unclaimed' and f.kind='phone' and f.created_at<now()-interval '24 hours' limit 100);get diagnostics d=row_count;
 return jsonb_build_object('expiredPhoneReceipts',r,'expiredPhoneRanges',h,'expiredBoots',b,'expiredUnclaimed',d);
end $$;
create index phone_ranges_cleanup on svitlo_sensors.phone_ranges(end_at);
create index phone_boots_cleanup on svitlo_sensors.phone_boots(created_at);
