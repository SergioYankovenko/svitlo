-- Additive1016. Native phone control only; ordinary get and permanent factory labels stay unchanged.
alter table svitlo_sensors.phone_devices add column manual_code_hash text unique,
 add column manual_code_cipher text,add column manual_qr_hash text,
 add constraint manual_code_hash_format check(manual_code_hash is null or manual_code_hash~'^[a-f0-9]{64}$'),
 add constraint manual_code_pair check((manual_code_hash is null)=(manual_code_cipher is null) and (manual_code_hash is null)=(manual_qr_hash is null));

-- Reserve used six-digit codes for 24 hours, including revoked ones: immediate reuse is forbidden.
create table svitlo_sensors.phone_manual_codes(code_hash text primary key check(code_hash~'^[a-f0-9]{64}$'),
 sensor_id uuid not null references svitlo_sensors.phone_devices on delete cascade,created_at timestamptz not null default clock_timestamp());
create index phone_manual_codes_expiry on svitlo_sensors.phone_manual_codes(created_at);
create table svitlo_sensors.phone_manual_attempts(subject uuid primary key references auth.users on delete cascade,
 window_start timestamptz not null,failures integer not null default 0 check(failures between 0 and 5));
do $$ declare t text;begin
 foreach t in array array['phone_manual_codes','phone_manual_attempts'] loop
  execute format('alter table svitlo_sensors.%I owner to svitlo_sensor_owner',t);
  execute format('alter table svitlo_sensors.%I enable row level security',t);
  execute format('alter table svitlo_sensors.%I force row level security',t);
  execute format('create policy manual_owner on svitlo_sensors.%I to svitlo_sensor_owner using(true) with check(true)',t);
  execute format('revoke all on svitlo_sensors.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);
 end loop;
end $$;

create function svitlo_sensors.phone_qr_get(op text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;f svitlo_sensors.phone_devices;begin
 if op not in ('owner_qr','reader_qr') or coalesce(p->>'manualHash','')!~'^[a-f0-9]{64}$' or length(coalesce(p->>'manualCipher','')) not between 40 and 160 then
  return jsonb_build_object('http',400,'code','invalid_phone_packet');end if;
 r:=svitlo_sensors.phone_command(op,p);
 if (r->>'http')::integer>=400 or r->>'kind'<>'phone_owner' then return r;end if;
 -- The nested command retains its device lock for this transaction.
 select * into f from svitlo_sensors.phone_devices where sensor_id=(p->>'sensorId')::uuid;
 if f.manual_code_hash is null or f.manual_qr_hash is distinct from f.qr_hash then
  insert into svitlo_sensors.phone_manual_codes(code_hash,sensor_id) values(p->>'manualHash',f.sensor_id);
  update svitlo_sensors.phone_devices set manual_code_hash=p->>'manualHash',manual_code_cipher=p->>'manualCipher',manual_qr_hash=qr_hash
   where sensor_id=f.sensor_id returning * into f;
 end if;
 return r||jsonb_build_object('manualCipher',f.manual_code_cipher,'manualHash',f.manual_code_hash);
exception when unique_violation then return jsonb_build_object('http',409,'code','phone_manual_code_collision');
end $$;
alter function svitlo_sensors.phone_qr_get(text,jsonb) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.phone_qr_get(text,jsonb) from public,anon,authenticated,svitlo_stage_worker;
grant execute on function svitlo_sensors.phone_qr_get(text,jsonb) to svitlo_stage_api;
create table svitlo_sensors.phone_qr_rotations(
 sensor_id uuid not null references svitlo_sensors.phone_devices on delete cascade,
 request_id uuid not null,issued_hash text not null check(issued_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz not null,expires_at timestamptz not null,
 primary key(sensor_id,request_id)
);
create index phone_qr_rotations_expiry on svitlo_sensors.phone_qr_rotations(created_at);
create index phone_qr_rotations_rate on svitlo_sensors.phone_qr_rotations(sensor_id,created_at);
alter table svitlo_sensors.phone_qr_rotations owner to svitlo_sensor_owner;
alter table svitlo_sensors.phone_qr_rotations enable row level security;
alter table svitlo_sensors.phone_qr_rotations force row level security;
create policy qr_rotation_owner on svitlo_sensors.phone_qr_rotations to svitlo_sensor_owner using(true) with check(true);
revoke all on svitlo_sensors.phone_qr_rotations from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;

create function svitlo_sensors.phone_qr_rotate(p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare d svitlo_sensors.devices;f svitlo_sensors.phone_devices;r svitlo_sensors.phone_qr_rotations;
 stamp timestamptz:=clock_timestamp();duplicate boolean:=false;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>4096 or
    p-array['sensorId','controlHash','requestId','qrHash','qrCipher','manualHash','manualCipher']<>'{}'::jsonb or
    coalesce(p->>'controlHash','')!~'^[a-f0-9]{64}$' or coalesce(p->>'qrHash','')!~'^[a-f0-9]{64}$' or
    length(coalesce(p->>'qrCipher','')) not between 80 and 256 or coalesce(p->>'manualHash','')!~'^[a-f0-9]{64}$' or
    length(coalesce(p->>'manualCipher','')) not between 40 and 160 then
  return jsonb_build_object('http',400,'code','invalid_phone_packet');
 end if;
 -- Same device lock as get/consume/relocate: old proof invalidation and new issuance are atomic.
 select * into d from svitlo_sensors.devices where sensor_id=(p->>'sensorId')::uuid for update;
 stamp:=clock_timestamp();
 select * into f from svitlo_sensors.phone_devices where sensor_id=d.sensor_id;
 if f.sensor_id is null then return jsonb_build_object('http',404,'code','phone_not_available');end if;
 if f.control_hash is distinct from p->>'controlHash' then return jsonb_build_object('http',401,'code','phone_control_unauthorized');end if;
 if f.kind<>'phone' then return jsonb_build_object('http',403,'code','phone_qr_rotation_not_allowed');end if;
 if (p->>'requestId')::uuid is null then return jsonb_build_object('http',400,'code','invalid_phone_packet');end if;
 select * into r from svitlo_sensors.phone_qr_rotations where sensor_id=d.sensor_id and request_id=(p->>'requestId')::uuid;
 if found then
  if r.issued_hash is distinct from f.qr_hash then return jsonb_build_object('http',409,'code','phone_qr_superseded');end if;
  if r.expires_at<=stamp or f.qr_expires_at<=stamp or f.qr_consumed_at is not null then return jsonb_build_object('http',409,'code','phone_qr_not_active');end if;
  duplicate:=true;
 else
  update svitlo_sensors.phone_devices set rate_at=case when rate_at<stamp-interval '1 minute' then stamp else rate_at end,
   rate_count=case when rate_at<stamp-interval '1 minute' then 1 else rate_count+1 end where sensor_id=d.sensor_id returning * into f;
  if f.rate_count>120 or (select count(*) from svitlo_sensors.phone_qr_rotations where sensor_id=d.sensor_id and created_at>stamp-interval '1 minute')>=12 or
   (select count(*) from svitlo_sensors.phone_qr_rotations where sensor_id=d.sensor_id and created_at>stamp-interval '24 hours')>=96 then
   return jsonb_build_object('http',429,'code','phone_qr_rotation_limit');
  end if;
  insert into svitlo_sensors.phone_manual_codes(code_hash,sensor_id,created_at) values(p->>'manualHash',d.sensor_id,stamp);
  update svitlo_sensors.phone_devices set qr_hash=p->>'qrHash',qr_cipher=p->>'qrCipher',qr_expires_at=stamp+interval '15 minutes',qr_consumed_at=null,
   manual_code_hash=p->>'manualHash',manual_code_cipher=p->>'manualCipher',manual_qr_hash=p->>'qrHash'
   where sensor_id=d.sensor_id returning * into f;
  insert into svitlo_sensors.phone_qr_rotations values(d.sensor_id,(p->>'requestId')::uuid,f.qr_hash,stamp,f.qr_expires_at);
 end if;
 return jsonb_build_object('http',200,'schemaVersion',1,'kind','phone_owner','requestId',p->>'requestId','duplicate',duplicate,
  'expiresAt',f.qr_expires_at,'privateCipher',f.qr_cipher,'privateHash',f.qr_hash,'manualCipher',f.manual_code_cipher,'manualHash',f.manual_code_hash);
exception when invalid_text_representation then return jsonb_build_object('http',400,'code','invalid_phone_packet');
 when unique_violation then return jsonb_build_object('http',409,'code','phone_manual_code_collision');
end $$;
alter function svitlo_sensors.phone_qr_rotate(jsonb) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.phone_qr_rotate(jsonb) from public,anon,authenticated,svitlo_stage_worker;
grant execute on function svitlo_sensors.phone_qr_rotate(jsonb) to svitlo_stage_api;

create function svitlo_sensors.phone_code_connect(p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();f svitlo_sensors.phone_devices;packet jsonb;r svitlo_sensors.commands;result jsonb;attempt svitlo_sensors.phone_manual_attempts;t timestamptz:=clock_timestamp();begin
 if actor is null then raise insufficient_privilege;end if;
 if p is null or jsonb_typeof(p)<>'object' or p-array['requestId','codeHash','profileId']<>'{}'::jsonb or
  coalesce(p->>'codeHash','')!~'^[a-f0-9]{64}$' or (p->>'requestId')::uuid is null then return jsonb_build_object('http',400,'code','invalid_phone_packet');end if;
 -- Charge unknown code attempts too; a code grants no subscription or profile bypass.
 perform pg_advisory_xact_lock(311032106);
 if not svitlo_sensors.take_rate(actor) then return jsonb_build_object('http',429,'code','sensor_request_limit');end if;
 insert into svitlo_sensors.phone_manual_attempts values(actor,t,0) on conflict do nothing;
 select * into attempt from svitlo_sensors.phone_manual_attempts where subject=actor for update;
 if attempt.window_start<t-interval '15 minutes' then update svitlo_sensors.phone_manual_attempts set window_start=t,failures=0 where subject=actor returning * into attempt;end if;
 if attempt.failures>=5 then return jsonb_build_object('http',429,'code','phone_code_attempt_limit');end if;
 select * into r from svitlo_sensors.commands where subject=actor and request_id=(p->>'requestId')::uuid;
 if found then
  if r.operation<>'phone_connect' or r.refs->>'manualCodeHash' is distinct from p->>'codeHash' then return jsonb_build_object('http',409,'code','sensor_request_id_conflict');end if;
  packet:=jsonb_build_object('requestId',p->'requestId','sensorId',r.refs->'sensorId','kind','phone_owner','qrHash',r.refs->>'manualQrHash');
 else
  select * into f from svitlo_sensors.phone_devices where manual_code_hash=p->>'codeHash' and kind='phone';
  if not found or f.manual_qr_hash is distinct from f.qr_hash or f.qr_expires_at<=clock_timestamp() then
   update svitlo_sensors.phone_manual_attempts set failures=failures+1 where subject=actor;
   return jsonb_build_object('http',404,'code','owner_qr_not_available');end if;
  packet:=jsonb_build_object('requestId',p->'requestId','sensorId',f.sensor_id,'kind','phone_owner','qrHash',f.qr_hash);
 end if;
 if p?'profileId' then packet:=packet||jsonb_build_object('profileId',p->'profileId');end if;
 -- Current subscription/ownership checks and device locking remain in the canonical command.
 result:=svitlo_sensors.phone_command('connect',packet);
 if (result->>'http')::integer=200 then
  update svitlo_sensors.commands set refs=refs||jsonb_build_object('manualCodeHash',p->>'codeHash','manualQrHash',packet->>'qrHash') where subject=actor and request_id=(p->>'requestId')::uuid;
  update svitlo_sensors.phone_manual_attempts set failures=0 where subject=actor;
 else update svitlo_sensors.phone_manual_attempts set failures=least(5,failures+1) where subject=actor;end if;
 return result;
exception when invalid_text_representation then return jsonb_build_object('http',400,'code','invalid_phone_packet');
end $$;
alter function svitlo_sensors.phone_code_connect(jsonb) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.phone_code_connect(jsonb) from public,anon,authenticated,svitlo_stage_worker;
grant execute on function svitlo_sensors.phone_code_connect(jsonb) to svitlo_stage_api;

-- Preserve the established bounded 90/91-day cleanup; add bounded 24-hour idempotency receipts.
alter function svitlo_sensors.phone_cleanup() rename to phone_cleanup_before_qr_rotation;
revoke all on function svitlo_sensors.phone_cleanup_before_qr_rotation() from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;
create function svitlo_sensors.phone_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;n integer;begin
 result:=svitlo_sensors.phone_cleanup_before_qr_rotation();
 delete from svitlo_sensors.phone_qr_rotations where (sensor_id,request_id) in
  (select sensor_id,request_id from svitlo_sensors.phone_qr_rotations where created_at<now()-interval '24 hours' order by created_at limit 1000 for update skip locked);
 get diagnostics n=row_count;
 delete from svitlo_sensors.phone_manual_codes where code_hash in(select code_hash from svitlo_sensors.phone_manual_codes where created_at<now()-interval '24 hours' order by created_at limit 1000 for update skip locked);
 delete from svitlo_sensors.phone_manual_attempts where subject in(select subject from svitlo_sensors.phone_manual_attempts where window_start<now()-interval '24 hours' order by window_start limit 1000 for update skip locked);
 return result||jsonb_build_object('expiredQrRotationReceipts',n);
end $$;
alter function svitlo_sensors.phone_cleanup() owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.phone_cleanup() from public,anon,authenticated,svitlo_stage_api;
grant execute on function svitlo_sensors.phone_cleanup() to svitlo_stage_worker;
