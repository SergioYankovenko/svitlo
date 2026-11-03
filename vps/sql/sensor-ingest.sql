-- Plan233: test-device ingestion and authenticated current point signal, not interval history.
create table svitlo_sensors.ingest_policy(id boolean primary key default true check(id),fresh_seconds integer not null default 180 check(fresh_seconds between 30 and 900),requests_per_minute integer not null default 120 check(requests_per_minute between 10 and 240));
insert into svitlo_sensors.ingest_policy(id) values(true);
create table svitlo_sensors.ingest_credentials(
 binding_id uuid primary key references svitlo_sensors.bindings on delete cascade,
 stream_id uuid not null unique default gen_random_uuid(),token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 issued_at timestamptz not null default now(),revoked_at timestamptz,rate_at timestamptz not null default now(),rate_count integer not null default 0
);
create table svitlo_sensors.ingest_latest(
 binding_id uuid primary key references svitlo_sensors.bindings on delete cascade,stream_id uuid not null,
 max_sequence bigint not null default 0 check(max_sequence between 0 and 9007199254740991),
 accepted_total bigint not null default 0,last_received_at timestamptz,
 last_confirmed_at timestamptz,last_observed_at timestamptz,last_confirmed_state text check(last_confirmed_state in ('on','off')),
 trusted_sample boolean not null default false,sequence_gap boolean not null default false,
 check((last_confirmed_at is null)=(last_confirmed_state is null))
);
create table svitlo_sensors.ingest_receipts(
 receipt_id uuid primary key default gen_random_uuid(),binding_id uuid not null references svitlo_sensors.bindings on delete cascade,
 stream_id uuid not null,event_id uuid not null,sequence bigint not null check(sequence between 1 and 9007199254740991),
 packet_hash text not null,received_at timestamptz not null,event_type text not null check(event_type in ('sample','heartbeat')),
 observed_at timestamptz,clock_quality text not null check(clock_quality in ('synchronized','unsynchronized')),
 power_state text check(power_state in ('on','off')),outcome text not null,
 unique(binding_id,stream_id,sequence),unique(binding_id,stream_id,event_id)
);
create index sensor_ingest_receipt_expiry on svitlo_sensors.ingest_receipts(received_at);
create index sensor_ingest_receipt_binding_time on svitlo_sensors.ingest_receipts(binding_id,received_at desc,receipt_id desc);

create function svitlo_sensors.admin_ingest_credential(sensor uuid,binding_epoch integer,hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare d svitlo_sensors.devices;b svitlo_sensors.bindings;c svitlo_sensors.ingest_credentials;begin
 if hash is not null and hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid ingest hash';end if;
 select * into d from svitlo_sensors.devices where sensor_id=$1 and is_test and status='bound' and current_epoch=$2 for update;
 if not found then raise exception 'An active test binding is required';end if;
 select * into b from svitlo_sensors.bindings where sensor_id=$1 and epoch=$2 and ended_at is null;
 if not found then raise exception 'An active test binding is required';end if;
 if hash is null then
  update svitlo_sensors.ingest_credentials set revoked_at=clock_timestamp() where binding_id=b.binding_id;
  insert into svitlo_sensors.audit(operation,sensor_id,epoch) values('admin_ingest_revoke',sensor,binding_epoch);
  return jsonb_build_object('revoked',true);
 end if;
 insert into svitlo_sensors.ingest_credentials(binding_id,token_hash) values(b.binding_id,hash)
 on conflict(binding_id) do update set token_hash=excluded.token_hash,stream_id=gen_random_uuid(),issued_at=clock_timestamp(),revoked_at=null returning * into c;
 insert into svitlo_sensors.ingest_latest(binding_id,stream_id) values(b.binding_id,c.stream_id)
 on conflict(binding_id) do update set stream_id=excluded.stream_id,max_sequence=0,last_received_at=null,last_confirmed_at=null,last_observed_at=null,last_confirmed_state=null,trusted_sample=false,sequence_gap=false;
 insert into svitlo_sensors.audit(operation,sensor_id,epoch) values('admin_ingest_issue',sensor,binding_epoch);
 return jsonb_build_object('sensorId',sensor,'bindingEpoch',binding_epoch,'streamId',c.stream_id,'isTest',true);
end $$;

create function svitlo_sensors.ingest(p jsonb,proof text) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare keys text[]:=array['schemaVersion','sensorId','bindingEpoch','streamId','eventId','sequence','eventType','powerState','observedAt','clockQuality'];k text;
 d svitlo_sensors.devices;b svitlo_sensors.bindings;c svitlo_sensors.ingest_credentials;s svitlo_sensors.ingest_latest;r svitlo_sensors.ingest_receipts;cfg svitlo_sensors.ingest_policy;
 stamp timestamptz;at_time timestamptz;seq bigint;hash text;outcome text;gap boolean;advance boolean:=false;begin
 if p is null or jsonb_typeof(p) is distinct from 'object' or p-keys<>'{}'::jsonb or not(p ?& keys) or octet_length(p::text)>2048 then return jsonb_build_object('http',400,'code','invalid_ingest_packet');end if;
 if p->'schemaVersion'<>'1'::jsonb then return jsonb_build_object('http',400,'code','unsupported_ingest_schema');end if;
 foreach k in array array['sensorId','streamId','eventId'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or (p->>k)!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return jsonb_build_object('http',400,'code','invalid_ingest_identity');end if;
 end loop;
 if jsonb_typeof(p->'bindingEpoch') is distinct from 'number' or (p->>'bindingEpoch')!~'^[0-9]{1,9}$' or (p->>'bindingEpoch')::integer<1
 or jsonb_typeof(p->'sequence') is distinct from 'number' or (p->>'sequence')!~'^[0-9]{1,16}$' then return jsonb_build_object('http',400,'code','invalid_ingest_sequence');end if;
 seq:=(p->>'sequence')::bigint;if seq<1 or seq>9007199254740991 then return jsonb_build_object('http',400,'code','invalid_ingest_sequence');end if;
 if coalesce(p->>'eventType','') not in ('sample','heartbeat') or coalesce(p->>'clockQuality','') not in ('synchronized','unsynchronized') then return jsonb_build_object('http',400,'code','invalid_ingest_sample');end if;
 if (p->>'eventType'='sample' and coalesce(p->>'powerState','') not in ('on','off')) or (p->>'eventType'='heartbeat' and p->'powerState'<>'null'::jsonb) then return jsonb_build_object('http',400,'code','invalid_ingest_sample');end if;
 if p->>'clockQuality'='synchronized' then
  if jsonb_typeof(p->'observedAt') is distinct from 'string' or (p->>'observedAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then return jsonb_build_object('http',400,'code','invalid_ingest_time');end if;
  begin at_time:=(p->>'observedAt')::timestamptz;exception when datetime_field_overflow or invalid_datetime_format then return jsonb_build_object('http',400,'code','invalid_ingest_time');end;
 elsif p->'observedAt'<>'null'::jsonb then return jsonb_build_object('http',400,'code','invalid_ingest_time');end if;
 if proof is null or proof!~'^[a-f0-9]{64}$' then return jsonb_build_object('http',401,'code','sensor_ingest_unauthorized');end if;
 -- The device row serializes only this physical sensor, and also fences rotation/disconnect.
 select d0.* into d from svitlo_sensors.devices d0 join svitlo_sensors.bindings b0 on b0.sensor_id=d0.sensor_id and b0.epoch=d0.current_epoch and b0.ended_at is null
 join svitlo_sensors.ingest_credentials c0 on c0.binding_id=b0.binding_id
 where d0.sensor_id=(p->>'sensorId')::uuid and d0.current_epoch=(p->>'bindingEpoch')::integer and d0.status='bound' and d0.is_test and c0.token_hash=proof and c0.revoked_at is null for update of d0;
 if not found then return jsonb_build_object('http',401,'code','sensor_ingest_unauthorized');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=d.sensor_id and epoch=d.current_epoch and ended_at is null;
 select * into c from svitlo_sensors.ingest_credentials where binding_id=b.binding_id and token_hash=proof and revoked_at is null and stream_id=(p->>'streamId')::uuid;
 if not found or b.binding_id is null then return jsonb_build_object('http',401,'code','sensor_ingest_unauthorized');end if;
 stamp:=clock_timestamp();select * into cfg from svitlo_sensors.ingest_policy where id;
 update svitlo_sensors.ingest_credentials set rate_count=case when rate_at<stamp-interval '1 minute' then 1 else least(rate_count+1,1000000) end,rate_at=case when rate_at<stamp-interval '1 minute' then stamp else rate_at end where binding_id=b.binding_id returning * into c;
 if c.rate_count>cfg.requests_per_minute then return jsonb_build_object('http',429,'code','sensor_ingest_rate');end if;
 hash:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 select * into r from svitlo_sensors.ingest_receipts where binding_id=b.binding_id and stream_id=c.stream_id and (event_id=(p->>'eventId')::uuid or sequence=seq) order by received_at limit 1;
 if found then
  if r.packet_hash<>hash then return jsonb_build_object('http',409,'code','sensor_event_conflict');end if;
  return jsonb_build_object('http',200,'schemaVersion',1,'accepted',true,'duplicate',true,'outcome',r.outcome,'eventId',r.event_id,'sequence',r.sequence,'receivedAt',r.received_at);
 end if;
 if at_time>stamp+interval '5 seconds' or at_time<stamp-interval '7 days' then return jsonb_build_object('http',400,'code','sensor_time_out_of_range');end if;
 select * into s from svitlo_sensors.ingest_latest where binding_id=b.binding_id;
 -- The durable watermark also protects state after old receipts have expired.
 if seq<=s.max_sequence then return jsonb_build_object('http',200,'schemaVersion',1,'accepted',true,'duplicate',false,'outcome','ignored_out_of_order','eventId',p->'eventId','sequence',seq,'receivedAt',stamp);end if;
 gap:=seq>s.max_sequence+1;outcome:='heartbeat';
 if p->>'eventType'='sample' then
  if at_time is null then outcome:='clock_untrusted';
  elsif s.last_confirmed_at is not null and at_time<s.last_confirmed_at then outcome:='ignored_late';
  else advance:=true;outcome:=case when at_time<stamp-make_interval(secs=>cfg.fresh_seconds) then 'accepted_late' else 'sample' end;end if;
 end if;
 update svitlo_sensors.ingest_latest set max_sequence=seq,accepted_total=accepted_total+1,last_received_at=stamp,sequence_gap=gap,
 last_confirmed_at=case when advance then least(at_time,stamp) else last_confirmed_at end,
 last_observed_at=case when advance then at_time else last_observed_at end,
 last_confirmed_state=case when advance then p->>'powerState' else last_confirmed_state end,
 trusted_sample=case when outcome='clock_untrusted' then false when advance then true else trusted_sample end
 where binding_id=b.binding_id returning * into s;
 insert into svitlo_sensors.ingest_receipts(binding_id,stream_id,event_id,sequence,packet_hash,received_at,event_type,observed_at,clock_quality,power_state,outcome)
 values(b.binding_id,c.stream_id,(p->>'eventId')::uuid,seq,hash,stamp,p->>'eventType',at_time,p->>'clockQuality',p->>'powerState',outcome);
 -- Trim in small batches, not an unbounded count/scan on every heartbeat. <=9999 rows/binding.
 if s.accepted_total%100=0 then delete from svitlo_sensors.ingest_receipts where receipt_id in(select receipt_id from svitlo_sensors.ingest_receipts where binding_id=b.binding_id order by received_at desc,receipt_id desc offset 9900 limit 1000);end if;
 return jsonb_build_object('http',200,'schemaVersion',1,'accepted',true,'duplicate',false,'outcome',outcome,'eventId',p->'eventId','sequence',seq,'receivedAt',stamp);
end $$;

create function svitlo_sensors.signal(sensor uuid,binding_epoch integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();view jsonb;s svitlo_sensors.ingest_latest;c svitlo_sensors.ingest_credentials;b svitlo_sensors.bindings;cfg svitlo_sensors.ingest_policy;t timestamptz:=clock_timestamp();online boolean;fresh boolean;reason text;begin
 if actor is null then raise insufficient_privilege;end if;
 if not svitlo_sensors.take_rate(actor) then return jsonb_build_object('http',429,'code','sensor_rate_limit');end if;
 view:=svitlo_sensors.packet($1,$2,actor);if view is null then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=$1 and epoch=$2 and ended_at is null;
 select * into s from svitlo_sensors.ingest_latest where binding_id=b.binding_id;
 select * into c from svitlo_sensors.ingest_credentials where binding_id=b.binding_id;
 select * into cfg from svitlo_sensors.ingest_policy where id;
 online:=s.last_received_at is not null and s.last_received_at>=t-make_interval(secs=>cfg.fresh_seconds);
 fresh:=coalesce(online and s.trusted_sample and s.last_confirmed_at>=t-make_interval(secs=>cfg.fresh_seconds) and c.revoked_at is null,false);
 reason:=case when c.binding_id is null then 'not_provisioned' when c.revoked_at is not null then 'credential_revoked' when s.last_confirmed_at is null then 'no_confirmed_sample' when not s.trusted_sample then 'clock_untrusted' when not fresh then 'stale_measurement' else null end;
 return jsonb_build_object('http',200,'schemaVersion',1,'signal',jsonb_build_object('sensorId',sensor,'bindingEpoch',binding_epoch,'measurementPointId',b.point_id,'streamId',c.stream_id,
 'serverTime',t,'powerState',case when fresh then s.last_confirmed_state else 'unknown' end,'availability',case when fresh then 'available' else 'unknown' end,'reason',reason,
 'transportState',case when s.last_received_at is null then 'never_seen' when online then 'online' else 'offline' end,
 'lastReceivedAt',s.last_received_at,'lastConfirmedState',s.last_confirmed_state,'lastConfirmedAt',s.last_confirmed_at,'observedAt',s.last_observed_at,
 'freshness',case when s.last_confirmed_at is null then 'never_seen' when fresh then 'fresh' else 'stale' end,'freshnessSeconds',cfg.fresh_seconds,
 'clockQuality',case when s.trusted_sample then 'synchronized' else 'unavailable' end,'sequence',s.max_sequence,
 'coverage',jsonb_build_object('kind','point_only','continuous',false,'sequenceGap',coalesce(s.sequence_gap,false)),'isTest',true));
end $$;

create function svitlo_sensors.ingest_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare removed integer;begin
 delete from svitlo_sensors.ingest_receipts where receipt_id in(select receipt_id from svitlo_sensors.ingest_receipts where received_at<now()-interval '7 days' order by received_at limit 1000);get diagnostics removed=row_count;
 return jsonb_build_object('expiredIngestReceipts',removed);
end $$;

do $$ declare t text;f regprocedure;begin
 foreach t in array array['ingest_policy','ingest_credentials','ingest_latest','ingest_receipts'] loop
  execute format('alter table svitlo_sensors.%I enable row level security',t);execute format('revoke all on table svitlo_sensors.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);execute format('alter table svitlo_sensors.%I owner to svitlo_sensor_owner',t);
 end loop;
 foreach f in array array['svitlo_sensors.admin_ingest_credential(uuid,integer,text)'::regprocedure,'svitlo_sensors.ingest(jsonb,text)'::regprocedure,'svitlo_sensors.signal(uuid,integer)'::regprocedure,'svitlo_sensors.ingest_cleanup()'::regprocedure] loop
  execute format('revoke all on function %s from public',f);execute format('alter function %s owner to svitlo_sensor_owner',f);
 end loop;
end $$;
grant execute on function svitlo_sensors.ingest(jsonb,text),svitlo_sensors.signal(uuid,integer) to svitlo_stage_api;
grant execute on function svitlo_sensors.ingest_cleanup() to svitlo_stage_worker;

create or replace function svitlo_sensors.packet(sensor uuid,binding_epoch integer,subject uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('sensorId',d.sensor_id,'bindingEpoch',b.epoch,'measurementPointId',b.point_id,'canonicalAddressId',b.address_id,'lineId',b.line_id,
 'membershipId',m.member_id,'role',m.role,'accessRevision',d.access_revision,'readerProfileId',l.profile_id,'isTest',d.is_test,
 'capabilities',jsonb_build_object('identity',true,'telemetry',true,'ingest',true,'signal',true,'observations',false,'prediction',false,'transfer',false,'recovery',false,'entitlement','not_configured'))
 from svitlo_sensors.devices d join svitlo_sensors.bindings b on b.sensor_id=d.sensor_id and b.epoch=d.current_epoch and b.ended_at is null
 join svitlo_sensors.memberships m on m.binding_id=b.binding_id and m.subject=$3 and m.revoked_at is null
 left join svitlo_sensors.reader_links l on l.member_id=m.member_id
 where d.sensor_id=$1 and b.epoch=$2 and d.status='bound'
$$;
