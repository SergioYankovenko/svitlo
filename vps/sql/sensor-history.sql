-- Plan234: explicit interval evidence. Legacy point samples never imply continuous coverage.
create table svitlo_sensors.history_events(
 history_id uuid primary key default gen_random_uuid(),binding_id uuid not null references svitlo_sensors.bindings on delete cascade,
 stream_id uuid not null,event_id uuid not null,sequence bigint not null,packet_hash text not null,protocol_version integer not null check(protocol_version in (1,2)),
 received_at timestamptz not null,observed_at timestamptz,event_type text not null,clock_quality text not null,power_state text,outcome text not null,sequence_gap boolean not null default false,
 coverage_start timestamptz,coverage_end timestamptz,
 unique(binding_id,stream_id,event_id),unique(binding_id,stream_id,sequence),
 check((coverage_start is null)=(coverage_end is null)),
 check(coverage_start is null or (protocol_version=2 and event_type='sample' and clock_quality='synchronized' and power_state in ('on','off') and coverage_start<coverage_end and coverage_end=observed_at and coverage_end-coverage_start<=interval '180 seconds'))
);
create index sensor_history_time on svitlo_sensors.history_events(binding_id,observed_at);
create index sensor_history_receive on svitlo_sensors.history_events(binding_id,received_at desc,history_id desc);
create index sensor_history_expiry on svitlo_sensors.history_events(received_at);
create index sensor_history_observed_expiry on svitlo_sensors.history_events(observed_at) where observed_at is not null;
create table svitlo_sensors.history_counters(binding_id uuid primary key references svitlo_sensors.bindings on delete cascade,total bigint not null);
-- Backfill only evidence actually retained in receipts; it remains point-only.
insert into svitlo_sensors.history_events(binding_id,stream_id,event_id,sequence,packet_hash,protocol_version,received_at,observed_at,event_type,clock_quality,power_state,outcome)
 select binding_id,stream_id,event_id,sequence,packet_hash,1,received_at,observed_at,event_type,clock_quality,power_state,outcome from svitlo_sensors.ingest_receipts;
insert into svitlo_sensors.history_counters select binding_id,count(*) from svitlo_sensors.history_events group by binding_id;

create function svitlo_sensors.history_bump(binding uuid) returns void language plpgsql set search_path='' as $$
declare n bigint;begin
 insert into svitlo_sensors.history_counters values(binding,1) on conflict(binding_id) do update set total=svitlo_sensors.history_counters.total+1 returning total into n;
 if n%100=0 then delete from svitlo_sensors.history_events where history_id in(select history_id from svitlo_sensors.history_events where binding_id=binding order by received_at desc,history_id desc offset 19900 limit 1000);end if;
end $$;
create function svitlo_sensors.capture_history() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into svitlo_sensors.history_events(binding_id,stream_id,event_id,sequence,packet_hash,protocol_version,received_at,observed_at,event_type,clock_quality,power_state,outcome,sequence_gap)
 values(new.binding_id,new.stream_id,new.event_id,new.sequence,new.packet_hash,1,new.received_at,new.observed_at,new.event_type,new.clock_quality,new.power_state,new.outcome,
 coalesce((select sequence_gap from svitlo_sensors.ingest_latest where binding_id=new.binding_id and stream_id=new.stream_id and max_sequence=new.sequence),false));
 perform svitlo_sensors.history_bump(new.binding_id);return new;
end $$;
create trigger sensor_history_capture after insert on svitlo_sensors.ingest_receipts for each row execute function svitlo_sensors.capture_history();

create function svitlo_sensors.ingest_with_history(p jsonb,proof text) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare keys text[]:=array['schemaVersion','sensorId','bindingEpoch','streamId','eventId','sequence','eventType','powerState','observedAt','clockQuality'];k text;v integer;legacy jsonb;hash text;result jsonb;
 d svitlo_sensors.devices;b svitlo_sensors.bindings;c svitlo_sensors.ingest_credentials;old svitlo_sensors.history_events;hid uuid;cs timestamptz;ce timestamptz;stamp timestamptz;begin
 if p is null or jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>2048 or p->'schemaVersion' not in ('1'::jsonb,'2'::jsonb) then return jsonb_build_object('http',400,'code','invalid_ingest_packet');end if;
 v:=(p->>'schemaVersion')::integer;if v=2 then keys:=array_append(keys,'coverage');end if;
 if p-keys<>'{}'::jsonb or not(p ?& keys) then return jsonb_build_object('http',400,'code','invalid_ingest_packet');end if;
 foreach k in array array['sensorId','streamId','eventId'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or (p->>k)!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return jsonb_build_object('http',400,'code','invalid_ingest_identity');end if;
 end loop;
 if jsonb_typeof(p->'bindingEpoch') is distinct from 'number' or (p->>'bindingEpoch')!~'^[0-9]{1,9}$' or (p->>'bindingEpoch')::integer<1 or jsonb_typeof(p->'sequence') is distinct from 'number' or (p->>'sequence')!~'^[0-9]{1,16}$' or (p->>'sequence')::bigint not between 1 and 9007199254740991 then return jsonb_build_object('http',400,'code','invalid_ingest_sequence');end if;
 if v=2 and p->'coverage'<>'null'::jsonb then
  if jsonb_typeof(p->'coverage') is distinct from 'object' or (p->'coverage')-array['startAt','endAt']<>'{}'::jsonb or not((p->'coverage') ?& array['startAt','endAt']) or p->>'eventType'<>'sample' or p->>'clockQuality'<>'synchronized' then return jsonb_build_object('http',400,'code','invalid_sensor_coverage');end if;
  foreach k in array array['startAt','endAt'] loop
   if jsonb_typeof(p->'coverage'->k) is distinct from 'string' or (p->'coverage'->>k)!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then return jsonb_build_object('http',400,'code','invalid_sensor_coverage');end if;
  end loop;
  begin cs:=(p->'coverage'->>'startAt')::timestamptz;ce:=(p->'coverage'->>'endAt')::timestamptz;
   if ce is distinct from (p->>'observedAt')::timestamptz or cs>=ce or ce-cs>interval '180 seconds' then return jsonb_build_object('http',400,'code','invalid_sensor_coverage');end if;
  exception when datetime_field_overflow or invalid_datetime_format then return jsonb_build_object('http',400,'code','invalid_sensor_coverage');end;
 end if;
 legacy:=jsonb_set(p-'coverage','{schemaVersion}','1'::jsonb);hash:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 -- Same physical-device lock as legacy ingest, including legacy code during a rolling deploy.
 select d0.* into d from svitlo_sensors.devices d0 join svitlo_sensors.bindings b0 on b0.sensor_id=d0.sensor_id and b0.epoch=d0.current_epoch and b0.ended_at is null
 join svitlo_sensors.ingest_credentials c0 on c0.binding_id=b0.binding_id where d0.sensor_id=(p->>'sensorId')::uuid and d0.current_epoch=(p->>'bindingEpoch')::integer and d0.status='bound' and d0.is_test and c0.token_hash=proof and c0.revoked_at is null for update of d0;
 if not found then return jsonb_build_object('http',401,'code','sensor_ingest_unauthorized');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=d.sensor_id and epoch=d.current_epoch and ended_at is null;
 select * into c from svitlo_sensors.ingest_credentials where binding_id=b.binding_id and token_hash=proof and revoked_at is null and stream_id=(p->>'streamId')::uuid;
 if not found then return jsonb_build_object('http',401,'code','sensor_ingest_unauthorized');end if;
 stamp:=clock_timestamp();
 if cs is not null and (cs<greatest(b.bound_at,c.issued_at) or ce>stamp) then return jsonb_build_object('http',400,'code','coverage_outside_stream');end if;
 select * into old from svitlo_sensors.history_events where binding_id=b.binding_id and stream_id=c.stream_id and (event_id=(p->>'eventId')::uuid or sequence=(p->>'sequence')::bigint) order by received_at limit 1;
 if found and old.packet_hash<>hash then return jsonb_build_object('http',409,'code','sensor_event_conflict');end if;
 result:=svitlo_sensors.ingest(legacy,proof);if (result->>'http')::integer>=400 then return result;end if;
 if old.history_id is not null then return result||jsonb_build_object('duplicate',true,'outcome',old.outcome,'receivedAt',old.received_at,'historyRecorded',true,'coverageRecorded',old.coverage_start is not null);end if;
 if v=1 and result->>'outcome'='ignored_out_of_order' then return result||jsonb_build_object('historyRecorded',false,'coverageRecorded',false);end if;
 select history_id into hid from svitlo_sensors.history_events where binding_id=b.binding_id and stream_id=c.stream_id and event_id=(p->>'eventId')::uuid;
 if hid is null then
  insert into svitlo_sensors.history_events(binding_id,stream_id,event_id,sequence,packet_hash,protocol_version,received_at,observed_at,event_type,clock_quality,power_state,outcome,coverage_start,coverage_end)
  values(b.binding_id,c.stream_id,(p->>'eventId')::uuid,(p->>'sequence')::bigint,hash,v,(result->>'receivedAt')::timestamptz,(p->>'observedAt')::timestamptz,p->>'eventType',p->>'clockQuality',p->>'powerState',result->>'outcome',cs,ce);
  perform svitlo_sensors.history_bump(b.binding_id);
 elsif v=2 then update svitlo_sensors.history_events set packet_hash=hash,protocol_version=2,coverage_start=cs,coverage_end=ce where history_id=hid;end if;
 return result||jsonb_build_object('historyRecorded',true,'coverageRecorded',cs is not null);
end $$;

create function svitlo_sensors.day_source(sensor uuid,binding_epoch integer,day text) returns jsonb language plpgsql security definer set search_path='' as $$
declare sig jsonb;view jsonb;b svitlo_sensors.bindings;dt date;today date;ds timestamptz;de timestamptz;t timestamptz;events jsonb;begin
 if day is null or day!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return jsonb_build_object('http',400,'code','invalid_sensor_date');end if;
 begin dt:=day::date;exception when datetime_field_overflow or invalid_datetime_format then return jsonb_build_object('http',400,'code','invalid_sensor_date');end;
 sig:=svitlo_sensors.signal($1,$2);if (sig->>'http')::integer>=400 then return sig;end if;
 t:=(sig->'signal'->>'serverTime')::timestamptz;today:=(t at time zone 'Europe/Kyiv')::date;
 if dt<today-6 or dt>today+1 then return jsonb_build_object('http',409,'code','sensor_date_not_available');end if;
 ds:=dt::timestamp at time zone 'Europe/Kyiv';de:=(dt+1)::timestamp at time zone 'Europe/Kyiv';
 view:=svitlo_sensors.packet($1,$2,auth.uid());if view is null then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=$1 and epoch=$2 and ended_at is null;
 select coalesce(jsonb_agg(to_jsonb(e) order by e."receivedAt",e."eventId"),'[]'::jsonb) into events from (
  select event_id as "eventId",stream_id as "streamId",sequence,protocol_version as "protocolVersion",observed_at as "observedAt",received_at as "receivedAt",event_type as "eventType",clock_quality as "clockQuality",power_state as "powerState",outcome,sequence_gap as "sequenceGap",coverage_start as "coverageStart",coverage_end as "coverageEnd"
  from svitlo_sensors.history_events where binding_id=b.binding_id and received_at<=t and
  ((observed_at>=ds and observed_at<de+interval '180 seconds' and observed_at>=b.bound_at) or (observed_at is null and received_at>=ds and received_at<de))
  order by received_at,event_id limit 5001
 ) e;
 return jsonb_build_object('http',200,'source',jsonb_build_object('date',day,'timezone','Europe/Kyiv','dayStartUtc',ds,'dayEndUtc',de,'asOf',t,'bindingStartedAt',b.bound_at,
 'sensor',view,'signal',sig->'signal','events',case when jsonb_array_length(events)>5000 then '[]'::jsonb else events end,'complete',jsonb_array_length(events)<=5000,'sourceEventCount',jsonb_array_length(events),
 'horizon',jsonb_build_object('fromDate',to_char(today-6,'YYYY-MM-DD'),'toDate',to_char(today+1,'YYYY-MM-DD'),'historyDays',7)));
end $$;
create function svitlo_sensors.history_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare removed integer;begin
 delete from svitlo_sensors.history_events where history_id in(select history_id from svitlo_sensors.history_events where received_at<now()-interval '7 days' or observed_at<now()-interval '7 days' order by received_at limit 1000);get diagnostics removed=row_count;
 return jsonb_build_object('expiredHistoryEvents',removed);
end $$;
do $$ declare t text;f regprocedure;begin
 foreach t in array array['history_events','history_counters'] loop
  execute format('alter table svitlo_sensors.%I enable row level security',t);execute format('revoke all on table svitlo_sensors.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);execute format('alter table svitlo_sensors.%I owner to svitlo_sensor_owner',t);
 end loop;
 foreach f in array array['svitlo_sensors.history_bump(uuid)'::regprocedure,'svitlo_sensors.capture_history()'::regprocedure,'svitlo_sensors.ingest_with_history(jsonb,text)'::regprocedure,'svitlo_sensors.day_source(uuid,integer,text)'::regprocedure,'svitlo_sensors.history_cleanup()'::regprocedure] loop
  execute format('revoke all on function %s from public',f);execute format('alter function %s owner to svitlo_sensor_owner',f);
 end loop;
end $$;
grant execute on function svitlo_sensors.ingest_with_history(jsonb,text),svitlo_sensors.day_source(uuid,integer,text) to svitlo_stage_api;
grant execute on function svitlo_sensors.history_cleanup() to svitlo_stage_worker;

create or replace function svitlo_sensors.packet(sensor uuid,binding_epoch integer,subject uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('sensorId',d.sensor_id,'bindingEpoch',b.epoch,'measurementPointId',b.point_id,'canonicalAddressId',b.address_id,'lineId',b.line_id,
 'membershipId',m.member_id,'role',m.role,'accessRevision',d.access_revision,'readerProfileId',l.profile_id,'isTest',d.is_test,
 'capabilities',jsonb_build_object('identity',true,'telemetry',true,'ingest',true,'signal',true,'observations',true,'history',true,'overview',true,'prediction',false,'transfer',false,'recovery',false,'entitlement','not_configured'))
 from svitlo_sensors.devices d join svitlo_sensors.bindings b on b.sensor_id=d.sensor_id and b.epoch=d.current_epoch and b.ended_at is null
 join svitlo_sensors.memberships m on m.binding_id=b.binding_id and m.subject=$3 and m.revoked_at is null
 left join svitlo_sensors.reader_links l on l.member_id=m.member_id
 where d.sensor_id=$1 and b.epoch=$2 and d.status='bound'
$$;
