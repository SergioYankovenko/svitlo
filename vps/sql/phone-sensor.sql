-- Plan235 / additive1008. Phone protocol3; Plan234 reserves1007 for legacy history.
create table svitlo_sensors.phone_devices(
 sensor_id uuid primary key references svitlo_sensors.devices on delete cascade,
 kind text not null check(kind in ('phone','factory')),registration_hash text unique,control_hash text not null unique,
 qr_hash text unique,qr_cipher text,qr_expires_at timestamptz,qr_consumed_at timestamptz,
 created_at timestamptz not null default now(),rate_at timestamptz not null default now(),rate_count integer not null default 0,
 check(control_hash ~ '^[a-f0-9]{64}$'),check(registration_hash is null or registration_hash ~ '^[a-f0-9]{64}$'),
 check(qr_hash is null or qr_hash ~ '^[a-f0-9]{64}$'),check((qr_hash is null)=(qr_cipher is null)),
 check(kind<>'factory' or (qr_hash is not null and qr_expires_at is null))
);
create table svitlo_sensors.phone_streams(binding_id uuid primary key references svitlo_sensors.bindings on delete cascade,ingest_cipher text not null);
create table svitlo_sensors.phone_receipts(
 binding_id uuid not null references svitlo_sensors.bindings on delete cascade,stream_id uuid not null,event_id uuid not null,
 sequence bigint not null,packet_hash text not null,received_at timestamptz not null,outcome text not null,
 primary key(binding_id,stream_id,event_id),unique(binding_id,stream_id,sequence)
);
create index phone_receipt_expiry on svitlo_sensors.phone_receipts(received_at);
create table svitlo_sensors.phone_boots(
 binding_id uuid not null references svitlo_sensors.bindings on delete cascade,stream_id uuid not null,boot_id uuid not null,
 anchor_at timestamptz not null,anchor_elapsed bigint not null,created_at timestamptz not null default now(),
 primary key(binding_id,stream_id,boot_id)
);
create table svitlo_sensors.phone_ranges(
 range_id uuid primary key default gen_random_uuid(),binding_id uuid not null references svitlo_sensors.bindings on delete cascade,
 stream_id uuid not null,boot_id uuid not null,monitor_id uuid not null,power_state text not null check(power_state in ('on','off')),
 start_at timestamptz not null,end_at timestamptz not null,check(start_at<end_at)
);
create index phone_range_day on svitlo_sensors.phone_ranges(binding_id,start_at,end_at);
create index phone_range_expiry on svitlo_sensors.phone_ranges(end_at);
alter function svitlo_sensors.packet(uuid,integer,uuid) rename to packet_before_phone;
create function svitlo_sensors.packet(sensor uuid,binding_epoch integer,subject uuid) returns jsonb language sql stable set search_path='' as $$
 select case when exists(select 1 from svitlo_sensors.phone_devices where sensor_id=$1) then
 jsonb_set(v,'{capabilities}',v->'capabilities'||jsonb_build_object('ownerQr',true,'transfer',true,'observations',true,'historyDays',90))||jsonb_build_object('sourceKind',(select kind from svitlo_sensors.phone_devices where sensor_id=$1)) else v end
 from(select svitlo_sensors.packet_before_phone($1,$2,$3) v) x
$$;
grant insert on public.svitlo_profiles to svitlo_sensor_owner;
create policy sensor_profile_insert on public.svitlo_profiles for insert to svitlo_sensor_owner with check(owner=auth.uid());

create function svitlo_sensors.phone_command(op text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare actor uuid:=auth.uid();d svitlo_sensors.devices;f svitlo_sensors.phone_devices;b svitlo_sensors.bindings;
 m svitlo_sensors.memberships;r svitlo_sensors.commands;profile public.svitlo_profiles;c svitlo_sensors.ingest_credentials;
 view jsonb;hash text;outcome text;address_id uuid;line_id uuid;address_data jsonb;stamp timestamptz:=clock_timestamp();begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>4096 then return jsonb_build_object('http',400,'code','invalid_phone_packet');end if;
 if op not in ('register','status','owner_qr','ingest_credentials','reader_qr','connect') then return jsonb_build_object('http',400,'code','invalid_phone_operation');end if;
 if op in ('connect','reader_qr') and actor is null then raise insufficient_privilege;end if;
 -- Match existing low-frequency membership lock. Ingest uses a per-device row lock only.
 perform pg_advisory_xact_lock(311032106);
 if actor is not null and not svitlo_sensors.take_rate(actor) then return jsonb_build_object('http',429,'code','sensor_request_limit');end if;
 if op='register' then
  if p-array['registrationHash','controlHash']<>'{}'::jsonb or coalesce(p->>'registrationHash','')!~'^[a-f0-9]{64}$' or coalesce(p->>'controlHash','')!~'^[a-f0-9]{64}$' then return jsonb_build_object('http',400,'code','invalid_phone_registration');end if;
  select * into f from svitlo_sensors.phone_devices where registration_hash=p->>'registrationHash';
  if found then
   if f.control_hash<>p->>'controlHash' then return jsonb_build_object('http',503,'code','phone_key_mismatch');end if;
   return jsonb_build_object('http',200,'schemaVersion',1,'sensorId',f.sensor_id,'duplicate',true,'isTest',true);
  end if;
  if (select count(*) from svitlo_sensors.phone_devices where created_at>stamp-interval '1 hour')>=100 or (select count(*) from svitlo_sensors.phone_devices)>=1000 then return jsonb_build_object('http',429,'code','phone_registration_limit');end if;
  insert into svitlo_sensors.devices(claim_expires_at) values(stamp+interval '24 hours') returning * into d;
  insert into svitlo_sensors.phone_devices(sensor_id,kind,registration_hash,control_hash) values(d.sensor_id,'phone',p->>'registrationHash',p->>'controlHash');
  return jsonb_build_object('http',201,'schemaVersion',1,'sensorId',d.sensor_id,'isTest',true,'duplicate',false);
 end if;
 select * into d from svitlo_sensors.devices where sensor_id=(p->>'sensorId')::uuid for update;
 select * into f from svitlo_sensors.phone_devices where sensor_id=d.sensor_id;
 if f.sensor_id is null then return jsonb_build_object('http',404,'code','phone_not_available');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=d.sensor_id and epoch=d.current_epoch and ended_at is null;
 if op in ('status','owner_qr','ingest_credentials') then
  if f.control_hash is distinct from p->>'controlHash' then return jsonb_build_object('http',401,'code','phone_control_unauthorized');end if;
  update svitlo_sensors.phone_devices set rate_at=case when rate_at<stamp-interval '1 minute' then stamp else rate_at end,rate_count=case when rate_at<stamp-interval '1 minute' then 1 else rate_count+1 end where sensor_id=d.sensor_id returning * into f;
  if f.rate_count>120 then return jsonb_build_object('http',429,'code','phone_control_limit');end if;
  if op='status' then return jsonb_build_object('http',200,'schemaVersion',1,'sensorId',d.sensor_id,'status',d.status,'bindingEpoch',d.current_epoch,'bound',b.binding_id is not null);end if;
 end if;
 if op in ('owner_qr','reader_qr') then
  if op='reader_qr' then
   view:=svitlo_sensors.packet(d.sensor_id,(p->>'bindingEpoch')::integer,actor);
   if view is null then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
   if view->>'role'<>'owner' then return jsonb_build_object('http',403,'code','sensor_owner_required');end if;
  elsif f.kind='factory' then return jsonb_build_object('http',403,'code','sensor_owner_required');end if;
  if f.kind='phone' and (f.qr_hash is null or f.qr_consumed_at is not null or f.qr_expires_at<=stamp) then
   if coalesce(p->>'qrHash','')!~'^[a-f0-9]{64}$' or length(coalesce(p->>'qrCipher','')) not between 80 and 256 then return jsonb_build_object('http',400,'code','invalid_phone_proof');end if;
   update svitlo_sensors.phone_devices set qr_hash=p->>'qrHash',qr_cipher=p->>'qrCipher',qr_expires_at=stamp+interval '15 minutes',qr_consumed_at=null where sensor_id=d.sensor_id returning * into f;
  end if;
  return jsonb_build_object('http',200,'schemaVersion',1,'kind',case when f.kind='phone' then 'phone_owner' else 'factory_owner' end,'expiresAt',f.qr_expires_at,'privateCipher',f.qr_cipher,'privateHash',f.qr_hash);
 end if;
 if op='ingest_credentials' then
  if b.binding_id is null or d.status<>'bound' then return jsonb_build_object('http',409,'code','phone_not_bound');end if;
  select * into c from svitlo_sensors.ingest_credentials where binding_id=b.binding_id;
  if c.binding_id is null then
   if coalesce(p->>'ingestHash','')!~'^[a-f0-9]{64}$' or length(coalesce(p->>'ingestCipher','')) not between 80 and 256 then return jsonb_build_object('http',400,'code','invalid_phone_proof');end if;
   insert into svitlo_sensors.ingest_credentials(binding_id,token_hash) values(b.binding_id,p->>'ingestHash') returning * into c;
   insert into svitlo_sensors.ingest_latest(binding_id,stream_id) values(b.binding_id,c.stream_id);
   insert into svitlo_sensors.phone_streams values(b.binding_id,p->>'ingestCipher');
  end if;
  if c.revoked_at is not null then return jsonb_build_object('http',409,'code','phone_credential_revoked');end if;
  return jsonb_build_object('http',200,'schemaVersion',1,'sensorId',d.sensor_id,'bindingEpoch',b.epoch,'streamId',c.stream_id,'privateHash',c.token_hash,'privateCipher',(select ingest_cipher from svitlo_sensors.phone_streams where binding_id=b.binding_id));
 end if;
 if op='connect' then
  if p-array['requestId','sensorId','kind','qrHash','profileId']<>'{}'::jsonb or coalesce(p->>'kind','') not in ('phone_owner','factory_owner') then return jsonb_build_object('http',400,'code','invalid_phone_packet');end if;
  hash:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
  select * into r from svitlo_sensors.commands where subject=actor and request_id=(p->>'requestId')::uuid;
  if found then
   if r.operation<>'phone_connect' or r.packet_hash<>hash then return jsonb_build_object('http',409,'code','sensor_request_id_conflict');end if;
   view:=svitlo_sensors.packet(d.sensor_id,(r.refs->>'epoch')::integer,actor);
   if view is null or view->>'role'<>'owner' or view->>'membershipId'<>r.refs->>'memberId' then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
   return jsonb_build_object('http',200,'schemaVersion',1,'sensor',view,'duplicate',true,'next','settings');
  end if;
  if f.qr_hash is distinct from p->>'qrHash' or (f.kind='phone')<>(p->>'kind'='phone_owner') or (f.qr_expires_at is not null and f.qr_expires_at<=stamp) then return jsonb_build_object('http',404,'code','owner_qr_not_available');end if;
  if b.owner_subject=actor then
   select * into m from svitlo_sensors.memberships where binding_id=b.binding_id and subject=actor and role='owner' and revoked_at is null;
   outcome:='already_owner';
  else
   if f.kind='phone' and f.qr_consumed_at is not null then return jsonb_build_object('http',409,'code','owner_qr_already_used');end if;
   if (select count(*) from svitlo_sensors.memberships where subject=actor and revoked_at is null and (b.binding_id is null or binding_id<>b.binding_id))>=10 then return jsonb_build_object('http',409,'code','sensor_membership_limit');end if;
   if b.binding_id is null then
    if d.status='disabled' then return jsonb_build_object('http',409,'code','sensor_requires_explicit_relocation');end if;
    select * into profile from public.svitlo_profiles where id=(p->>'profileId')::uuid and owner=actor;
    if profile.id is null then return jsonb_build_object('http',409,'code','first_connection_requires_profile');end if;
    address_id:=(profile.address->>'canonicalAddressId')::uuid;line_id:=(profile.address->>'lineId')::uuid;
    if address_id is null or not svitlo_vps.catalog_allowed(address_id) then return jsonb_build_object('http',409,'code','profile_requires_reselection');end if;
    if line_id is not null and not exists(select 1 from svitlo_vps.address_lines al where al.id=line_id and al.address_id=address_id and al.active) then return jsonb_build_object('http',409,'code','profile_line_not_available');end if;
   else
    address_id:=b.address_id;line_id:=b.line_id;
    perform pg_advisory_xact_lock(hashtextextended('svitlo-profile-owner:'||actor::text,0));
    select * into profile from public.svitlo_profiles sp where owner=actor and address->>'canonicalAddressId'=address_id::text and (address->>'lineId')::uuid is not distinct from line_id and not exists(select 1 from svitlo_sensors.reader_links l join svitlo_sensors.memberships sm using(member_id) where l.profile_id=sp.id and sm.binding_id<>b.binding_id) order by created_at limit 1;
    if profile.id is null then
     if (select count(*) from public.svitlo_profiles where owner=actor)>=10 then return jsonb_build_object('http',409,'code','profile_limit');end if;
     select address into address_data from public.svitlo_profiles where id=(select profile_id from svitlo_sensors.reader_links l join svitlo_sensors.memberships sm using(member_id) where sm.binding_id=b.binding_id and sm.subject=actor limit 1);
     -- Other owners' profiles are intentionally invisible. Canonical identity suffices for a private universal profile.
     address_data:=jsonb_build_object('canonicalAddressId',address_id,'lineId',line_id,'operatorId',(select operator_id from svitlo_vps.catalog where id=address_id),'department','universal:'||(select operator_id from svitlo_vps.catalog where id=address_id),'label',(select label from svitlo_vps.catalog where id=address_id));
     insert into public.svitlo_profiles(id,owner,address,name) values(gen_random_uuid(),actor,jsonb_strip_nulls(address_data),'Датчик') returning * into profile;
    end if;
   end if;
   if exists(select 1 from svitlo_sensors.reader_links l join svitlo_sensors.memberships sm using(member_id) where profile_id=profile.id and (b.binding_id is null or sm.binding_id<>b.binding_id)) then return jsonb_build_object('http',409,'code','profile_already_has_sensor');end if;
   if b.binding_id is null then
    update svitlo_sensors.devices set current_epoch=current_epoch+1,status='bound' where sensor_id=d.sensor_id returning * into d;
    insert into svitlo_sensors.bindings(sensor_id,epoch,owner_subject,address_id,line_id) values(d.sensor_id,d.current_epoch,actor,address_id,line_id) returning * into b;outcome:='connected';
   else
    delete from svitlo_sensors.reader_links where member_id in(select member_id from svitlo_sensors.memberships where binding_id=b.binding_id);
    update svitlo_sensors.memberships set revoked_at=coalesce(revoked_at,stamp) where binding_id=b.binding_id;
    update svitlo_sensors.invitations set revoked_at=coalesce(revoked_at,stamp) where binding_id=b.binding_id;
    update svitlo_sensors.bindings set owner_subject=actor where binding_id=b.binding_id;outcome:='transferred';
   end if;
   insert into svitlo_sensors.memberships(binding_id,subject,role) values(b.binding_id,actor,'owner') returning * into m;
   insert into svitlo_sensors.reader_links(member_id,profile_id) values(m.member_id,profile.id);
   update svitlo_sensors.devices set access_revision=access_revision+1 where sensor_id=d.sensor_id;
   if f.kind='phone' then update svitlo_sensors.phone_devices set qr_consumed_at=stamp where sensor_id=d.sensor_id;end if;
  end if;
  insert into svitlo_sensors.commands(subject,request_id,operation,packet_hash,refs) values(actor,(p->>'requestId')::uuid,'phone_connect',hash,jsonb_build_object('sensorId',d.sensor_id,'epoch',b.epoch,'memberId',m.member_id));
  insert into svitlo_sensors.audit(actor_subject,operation,sensor_id,epoch) values(actor,'phone_'||outcome,d.sensor_id,b.epoch);
  return jsonb_build_object('http',200,'schemaVersion',1,'sensor',svitlo_sensors.packet(d.sensor_id,b.epoch,actor),'outcome',outcome,'next','settings','duplicate',false);
 end if;
 return jsonb_build_object('http',400,'code','invalid_phone_operation');
end $$;

create function svitlo_sensors.phone_relocate(p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();d svitlo_sensors.devices;b svitlo_sensors.bindings;m svitlo_sensors.memberships;profile public.svitlo_profiles;r svitlo_sensors.commands;view jsonb;hash text;stamp timestamptz:=clock_timestamp();begin
 if actor is null then raise insufficient_privilege;end if;
 if p is null or p-array['sensorId','bindingEpoch','requestId','profileId','confirmed']<>'{}'::jsonb or not(p ?& array['sensorId','bindingEpoch','requestId','profileId','confirmed']) or p->'confirmed'<>'true'::jsonb then return jsonb_build_object('http',400,'code','invalid_phone_relocation');end if;
 perform pg_advisory_xact_lock(311032106);
 if not svitlo_sensors.take_rate(actor) then return jsonb_build_object('http',429,'code','sensor_rate_limit');end if;
 hash:=encode(sha256(convert_to(p::text,'UTF8')),'hex');select * into r from svitlo_sensors.commands where subject=actor and request_id=(p->>'requestId')::uuid;
 if found then
  if r.operation<>'phone_relocate' or r.packet_hash<>hash then return jsonb_build_object('http',409,'code','sensor_request_id_conflict');end if;
  view:=svitlo_sensors.packet((r.refs->>'sensorId')::uuid,(r.refs->>'epoch')::int,actor);
  if view is null or view->>'membershipId'<>r.refs->>'memberId' then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
  return jsonb_build_object('http',200,'schemaVersion',1,'sensor',view,'duplicate',true);
 end if;
 select * into d from svitlo_sensors.devices where sensor_id=(p->>'sensorId')::uuid and current_epoch=(p->>'bindingEpoch')::int and status='bound' for update;
 if d.sensor_id is null or not exists(select 1 from svitlo_sensors.phone_devices where sensor_id=d.sensor_id) then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=d.sensor_id and epoch=d.current_epoch and ended_at is null and owner_subject=actor;
 if b.binding_id is null then return jsonb_build_object('http',403,'code','sensor_owner_required');end if;
 select * into profile from public.svitlo_profiles where id=(p->>'profileId')::uuid and owner=actor;
 if profile.id is null then return jsonb_build_object('http',404,'code','profile_not_available');end if;
 if not coalesce(svitlo_vps.catalog_allowed((profile.address->>'canonicalAddressId')::uuid),false) then return jsonb_build_object('http',409,'code','profile_requires_reselection');end if;
 if exists(select 1 from svitlo_sensors.reader_links l join svitlo_sensors.memberships sm using(member_id) where profile_id=profile.id and sm.binding_id<>b.binding_id) then return jsonb_build_object('http',409,'code','profile_already_has_sensor');end if;
 if profile.address->>'lineId' is not null and not exists(select 1 from svitlo_vps.address_lines where id=(profile.address->>'lineId')::uuid and address_id=(profile.address->>'canonicalAddressId')::uuid and active) then return jsonb_build_object('http',409,'code','profile_line_not_available');end if;
 if (profile.address->>'canonicalAddressId')::uuid=b.address_id and (profile.address->>'lineId')::uuid is not distinct from b.line_id then return jsonb_build_object('http',409,'code','sensor_already_at_address');end if;
 update svitlo_sensors.bindings set ended_at=stamp where binding_id=b.binding_id;
 update svitlo_sensors.memberships set revoked_at=coalesce(revoked_at,stamp) where binding_id=b.binding_id;
 delete from svitlo_sensors.reader_links where member_id in(select member_id from svitlo_sensors.memberships where binding_id=b.binding_id);
 update svitlo_sensors.invitations set revoked_at=coalesce(revoked_at,stamp) where binding_id=b.binding_id;
 update svitlo_sensors.ingest_credentials set revoked_at=stamp where binding_id=b.binding_id;
 update svitlo_sensors.devices set current_epoch=current_epoch+1,access_revision=access_revision+1 where sensor_id=d.sensor_id returning * into d;
 insert into svitlo_sensors.bindings(sensor_id,epoch,owner_subject,address_id,line_id) values(d.sensor_id,d.current_epoch,actor,(profile.address->>'canonicalAddressId')::uuid,(profile.address->>'lineId')::uuid) returning * into b;
 insert into svitlo_sensors.memberships(binding_id,subject,role) values(b.binding_id,actor,'owner') returning * into m;
 insert into svitlo_sensors.reader_links values(m.member_id,profile.id,stamp);
 -- A previously issued phone proof must not transfer a newly relocated point. Factory label stays authoritative.
 update svitlo_sensors.phone_devices set qr_expires_at=stamp,qr_consumed_at=stamp where sensor_id=d.sensor_id and kind='phone';
 insert into svitlo_sensors.commands values(actor,(p->>'requestId')::uuid,'phone_relocate',hash,jsonb_build_object('sensorId',d.sensor_id,'epoch',b.epoch,'memberId',m.member_id),stamp);
 insert into svitlo_sensors.audit(actor_subject,operation,sensor_id,epoch) values(actor,'phone_relocate',d.sensor_id,b.epoch);
 return jsonb_build_object('http',200,'schemaVersion',1,'sensor',svitlo_sensors.packet(d.sensor_id,b.epoch,actor),'duplicate',false);
end $$;

-- Admin-only simulator for a future factory sticker. No public factory enrollment.
create function svitlo_sensors.admin_factory_phone(sid uuid,control_hash text,qr_hash text,qr_cipher text) returns uuid language plpgsql security definer set search_path='' as $$
begin
 if control_hash!~'^[a-f0-9]{64}$' or qr_hash!~'^[a-f0-9]{64}$' or length(qr_cipher) not between 80 and 256 then raise exception 'Invalid factory material';end if;
 insert into svitlo_sensors.devices(sensor_id,claim_expires_at) values(sid,now());
 insert into svitlo_sensors.phone_devices(sensor_id,kind,control_hash,qr_hash,qr_cipher) values(sid,'factory',control_hash,qr_hash,qr_cipher);return sid;
end $$;

create function svitlo_sensors.phone_history(sensor uuid,binding_epoch integer,day date) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();view jsonb;b svitlo_sensors.bindings;a timestamptz;z timestamptz;t timestamptz:=clock_timestamp();rs jsonb;sig jsonb;begin
 if actor is null then raise insufficient_privilege;end if;
 view:=svitlo_sensors.packet(sensor,binding_epoch,actor);if view is null then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
 if day is null or day<(t at time zone 'Europe/Kyiv')::date-90 or day>(t at time zone 'Europe/Kyiv')::date+1 then return jsonb_build_object('http',400,'code','sensor_history_day_out_of_range');end if;
 sig:=svitlo_sensors.phone_signal(sensor,binding_epoch);if (sig->>'http')::int>=400 then return sig;end if;
 select * into b from svitlo_sensors.bindings where sensor_id=sensor and epoch=binding_epoch and ended_at is null;
 a:=day::timestamp at time zone 'Europe/Kyiv';z:=(day+1)::timestamp at time zone 'Europe/Kyiv';
 select coalesce(jsonb_agg(jsonb_build_object('start',greatest(start_at,t-interval '90 days'),'end',end_at,'powerState',power_state)),'[]') into rs from(select * from svitlo_sensors.phone_ranges where binding_id=b.binding_id and end_at>a and start_at<z and end_at>t-interval '90 days' order by start_at limit 2001) x;
 return jsonb_build_object('http',200,'schemaVersion',1,'sensorId',sensor,'bindingEpoch',binding_epoch,'measurementPointId',b.point_id,'canonicalAddressId',b.address_id,'lineId',b.line_id,
  'date',day,'timezone','Europe/Kyiv','dayStartUtc',a,'dayEndUtc',z,'asOf',t,'signal',sig->'signal','complete',jsonb_array_length(rs)<=2000,'ranges',case when jsonb_array_length(rs)>2000 then '[]'::jsonb else rs end,'horizon',jsonb_build_object('historyDays',90,'futureMeasurements',false));
end $$;

create function svitlo_sensors.phone_signal(sensor uuid,binding_epoch integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();view jsonb;b svitlo_sensors.bindings;s svitlo_sensors.ingest_latest;c svitlo_sensors.ingest_credentials;t timestamptz:=clock_timestamp();online boolean;fresh boolean;begin
 if not exists(select 1 from svitlo_sensors.phone_devices where sensor_id=sensor) then return svitlo_sensors.signal(sensor,binding_epoch);end if;
 if actor is null then raise insufficient_privilege;end if;
 if not svitlo_sensors.take_rate(actor) then return jsonb_build_object('http',429,'code','sensor_rate_limit');end if;
 view:=svitlo_sensors.packet(sensor,binding_epoch,actor);if view is null then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=sensor and epoch=binding_epoch and ended_at is null;
 select * into s from svitlo_sensors.ingest_latest where binding_id=b.binding_id;select * into c from svitlo_sensors.ingest_credentials where binding_id=b.binding_id;
 online:=coalesce(s.last_received_at>=t-interval '15 minutes',false);fresh:=coalesce(online and s.trusted_sample and s.last_confirmed_at>=t-interval '15 minutes' and c.revoked_at is null,false);
 return jsonb_build_object('http',200,'schemaVersion',1,'signal',jsonb_build_object('sensorId',sensor,'bindingEpoch',binding_epoch,'measurementPointId',b.point_id,'streamId',c.stream_id,'serverTime',t,
 'powerState',case when fresh then s.last_confirmed_state else 'unknown' end,'availability',case when fresh then 'available' else 'unknown' end,
 'reason',case when fresh then null when not online then 'connection_lost' when not coalesce(s.trusted_sample,false) then 'clock_untrusted' else 'stale_measurement' end,
 'transportState',case when s.last_received_at is null then 'never_seen' when online then 'online' else 'offline' end,'lastReceivedAt',s.last_received_at,'lastConfirmedAt',s.last_confirmed_at,'lastConfirmedState',s.last_confirmed_state,'observedAt',s.last_observed_at,
 'freshnessSeconds',900,'freshness',case when fresh then 'fresh' else 'stale' end,'coverage',jsonb_build_object('kind','explicit_only','continuous',false),'isTest',true));
end $$;

create function svitlo_sensors.phone_ingest(p jsonb,proof text) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare d svitlo_sensors.devices;b svitlo_sensors.bindings;c svitlo_sensors.ingest_credentials;s svitlo_sensors.ingest_latest;r svitlo_sensors.phone_receipts;anchor svitlo_sensors.phone_boots;
 e jsonb;cv jsonb;acks jsonb:='[]';hash text;seq bigint;at_time timestamptz;stamp timestamptz:=clock_timestamp();trusted boolean;outcome text;lo timestamptz;hi timestamptz;rid uuid;begin
 if p is null or jsonb_typeof(p)<>'object' or p-array['schemaVersion','sensorId','bindingEpoch','streamId','events']<>'{}'::jsonb or p->'schemaVersion'<>'3'::jsonb or jsonb_typeof(p->'events')<>'array' or jsonb_array_length(p->'events') not between 1 and 50 or octet_length(p::text)>19000 then return jsonb_build_object('http',400,'code','invalid_phone_batch');end if;
 select d0.* into d from svitlo_sensors.devices d0 join svitlo_sensors.phone_devices f using(sensor_id) join svitlo_sensors.bindings b0 on b0.sensor_id=d0.sensor_id and b0.epoch=d0.current_epoch and b0.ended_at is null join svitlo_sensors.ingest_credentials c0 on c0.binding_id=b0.binding_id
 where d0.sensor_id=(p->>'sensorId')::uuid and d0.current_epoch=(p->>'bindingEpoch')::integer and d0.status='bound' and c0.token_hash=proof and c0.stream_id=(p->>'streamId')::uuid and c0.revoked_at is null for update of d0;
 if not found then return jsonb_build_object('http',401,'code','sensor_ingest_unauthorized');end if;
 select * into b from svitlo_sensors.bindings where sensor_id=d.sensor_id and epoch=d.current_epoch and ended_at is null;
 update svitlo_sensors.ingest_credentials set rate_count=case when rate_at<stamp-interval '1 minute' then 1 else rate_count+1 end,rate_at=case when rate_at<stamp-interval '1 minute' then stamp else rate_at end where binding_id=b.binding_id returning * into c;
 if c.rate_count>120 then return jsonb_build_object('http',429,'code','sensor_ingest_rate');end if;
 -- Subtransaction: a conflict anywhere rolls back this entire batch; never acknowledge a partial write.
 begin
 for e in select value from jsonb_array_elements(p->'events') loop
  if e-array['eventId','sequence','eventType','powerState','observedAt','clockQuality','bootId','elapsedRealtimeMs','monitorId','coverage']<>'{}'::jsonb or not(e ?& array['eventId','sequence','eventType','powerState','observedAt','clockQuality','bootId','elapsedRealtimeMs','monitorId','coverage']) then raise exception using errcode='P4000';end if;
  seq:=(e->>'sequence')::bigint;if seq not between 1 and 9007199254740991 or (e->>'elapsedRealtimeMs')::bigint not between 0 and 9007199254740991 or coalesce(e->>'eventType','') not in ('sample','heartbeat') or coalesce(e->>'clockQuality','') not in ('synchronized','unsynchronized') or (e->>'powerState' is not null and e->>'powerState' not in ('on','off')) or (e->>'eventType'='heartbeat' and e->>'powerState' is not null) then raise exception using errcode='P4000';end if;
  hash:=encode(sha256(convert_to(e::text,'UTF8')),'hex');
  select * into r from svitlo_sensors.phone_receipts where binding_id=b.binding_id and stream_id=c.stream_id and (event_id=(e->>'eventId')::uuid or sequence=seq);
  if found then
   if r.packet_hash<>hash then raise exception using errcode='P4090';end if;
   acks:=acks||jsonb_build_array(jsonb_build_object('eventId',e->'eventId','sequence',seq,'duplicate',true,'outcome',r.outcome));continue;
  end if;
  if (select count(*) from svitlo_sensors.phone_receipts where binding_id=b.binding_id)>=30000 then raise exception using errcode='P4290';end if;
  at_time:=(e->>'observedAt')::timestamptz;
  if (e->>'clockQuality'='unsynchronized' and at_time is not null) or (e->>'clockQuality'='synchronized' and at_time is null) or at_time>stamp+interval '5 seconds' or at_time<stamp-interval '90 days' then raise exception using errcode='P4000';end if;
  select * into anchor from svitlo_sensors.phone_boots where binding_id=b.binding_id and stream_id=c.stream_id and boot_id=(e->>'bootId')::uuid;
  if anchor.binding_id is null and e->>'clockQuality'='synchronized' and at_time>=stamp-interval '15 minutes' then
   if (select count(*) from svitlo_sensors.phone_boots where binding_id=b.binding_id)>=256 then raise exception using errcode='P4290';end if;
   insert into svitlo_sensors.phone_boots(binding_id,stream_id,boot_id,anchor_at,anchor_elapsed) values(b.binding_id,c.stream_id,(e->>'bootId')::uuid,at_time,(e->>'elapsedRealtimeMs')::bigint) returning * into anchor;
  end if;
  trusted:=coalesce(e->>'clockQuality'='synchronized' and anchor.binding_id is not null and abs(extract(epoch from (at_time-anchor.anchor_at))*1000-((e->>'elapsedRealtimeMs')::bigint-anchor.anchor_elapsed))<=5000,false);
  cv:=e->'coverage';
  if cv<>'null'::jsonb then
   lo:=(cv->>'startAt')::timestamptz;hi:=(cv->>'endAt')::timestamptz;
   if cv-array['startAt','endAt','startElapsedMs','endElapsedMs','powerState']<>'{}'::jsonb or not(cv ?& array['startAt','endAt','startElapsedMs','endElapsedMs','powerState']) or coalesce(cv->>'powerState','') not in ('on','off') or e->>'eventType'<>'sample' or lo is null or hi is null or hi is distinct from at_time or hi>stamp or lo>=hi or hi-lo>interval '5 minutes' or lo<c.issued_at or lo<stamp-interval '90 days' or hi>b.bound_at and lo<b.bound_at or (cv->>'endElapsedMs')::bigint is distinct from (e->>'elapsedRealtimeMs')::bigint or (cv->>'startElapsedMs')::bigint<0 or extract(epoch from(hi-lo))*1000<>((cv->>'endElapsedMs')::bigint-(cv->>'startElapsedMs')::bigint) then raise exception using errcode='P4000';end if;
   if trusted and lo>=b.bound_at then
    -- Coalesce only explicit overlapping/adjacent evidence for this monitoring run and state.
    select min(start_at),max(end_at) into lo,hi from (select lo start_at,hi end_at union all select start_at,end_at from svitlo_sensors.phone_ranges where binding_id=b.binding_id and stream_id=c.stream_id and boot_id=(e->>'bootId')::uuid and monitor_id=(e->>'monitorId')::uuid and power_state=cv->>'powerState' and start_at<=hi and end_at>=lo) x;
    delete from svitlo_sensors.phone_ranges where binding_id=b.binding_id and stream_id=c.stream_id and boot_id=(e->>'bootId')::uuid and monitor_id=(e->>'monitorId')::uuid and power_state=cv->>'powerState' and start_at<=hi and end_at>=lo;
    insert into svitlo_sensors.phone_ranges(binding_id,stream_id,boot_id,monitor_id,power_state,start_at,end_at) values(b.binding_id,c.stream_id,(e->>'bootId')::uuid,(e->>'monitorId')::uuid,cv->>'powerState',lo,hi);
   end if;
  end if;
  select * into s from svitlo_sensors.ingest_latest where binding_id=b.binding_id;
  outcome:=case when not trusted then 'clock_untrusted' when seq<=s.max_sequence then 'accepted_history' when at_time<stamp-interval '15 minutes' then 'accepted_late' else e->>'eventType' end;
  if seq>s.max_sequence then
   update svitlo_sensors.ingest_latest set max_sequence=seq,accepted_total=accepted_total+1,last_received_at=stamp,sequence_gap=seq>s.max_sequence+1,
    last_confirmed_at=case when trusted and e->>'eventType'='sample' and e->>'powerState' is not null and (s.last_confirmed_at is null or at_time>=s.last_confirmed_at) then least(at_time,stamp) else last_confirmed_at end,
    last_observed_at=case when trusted and e->>'eventType'='sample' and e->>'powerState' is not null and (s.last_confirmed_at is null or at_time>=s.last_confirmed_at) then at_time else last_observed_at end,
    last_confirmed_state=case when trusted and e->>'eventType'='sample' and e->>'powerState' is not null and (s.last_confirmed_at is null or at_time>=s.last_confirmed_at) then e->>'powerState' else last_confirmed_state end,
    trusted_sample=case when e->>'eventType'='sample' and (not trusted or e->>'powerState' is null) then false when e->>'eventType'='sample' and trusted and (s.last_confirmed_at is null or at_time>=s.last_confirmed_at) then true else trusted_sample end
   where binding_id=b.binding_id;
  end if;
  insert into svitlo_sensors.phone_receipts values(b.binding_id,c.stream_id,(e->>'eventId')::uuid,seq,hash,stamp,outcome);
  acks:=acks||jsonb_build_array(jsonb_build_object('eventId',e->'eventId','sequence',seq,'duplicate',false,'outcome',outcome));
 end loop;
 exception when sqlstate 'P4090' then return jsonb_build_object('http',409,'code','sensor_event_conflict');when sqlstate 'P4290' then return jsonb_build_object('http',429,'code','phone_history_capacity');when sqlstate 'P4000' or invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range or not_null_violation then return jsonb_build_object('http',400,'code','invalid_phone_event');end;
 return jsonb_build_object('http',200,'schemaVersion',3,'sensorId',d.sensor_id,'bindingEpoch',b.epoch,'acknowledged',acks,'serverTime',stamp);
end $$;

create function svitlo_sensors.phone_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer;begin
 delete from svitlo_sensors.phone_receipts where (binding_id,stream_id,event_id) in(select binding_id,stream_id,event_id from svitlo_sensors.phone_receipts where received_at<now()-interval '90 days' limit 1000);
 delete from svitlo_sensors.phone_ranges where range_id in(select range_id from svitlo_sensors.phone_ranges where end_at<now()-interval '90 days' limit 1000);get diagnostics n=row_count;
 update svitlo_sensors.phone_ranges set start_at=now()-interval '90 days' where range_id in(select range_id from svitlo_sensors.phone_ranges where start_at<now()-interval '90 days' and end_at>=now()-interval '90 days' limit 1000);
 delete from svitlo_sensors.phone_boots where (binding_id,stream_id,boot_id) in(select binding_id,stream_id,boot_id from svitlo_sensors.phone_boots where created_at<now()-interval '90 days' limit 1000);
 delete from svitlo_sensors.devices where sensor_id in(select d.sensor_id from svitlo_sensors.devices d join svitlo_sensors.phone_devices f using(sensor_id) where d.status='unclaimed' and f.kind='phone' and f.created_at<now()-interval '24 hours' limit 100);
 return jsonb_build_object('expiredPhoneRanges',n);
end $$;

do $$ declare t text;f regprocedure;begin
 foreach t in array array['phone_devices','phone_streams','phone_receipts','phone_boots','phone_ranges'] loop
  execute format('alter table svitlo_sensors.%I enable row level security',t);execute format('revoke all on table svitlo_sensors.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);execute format('alter table svitlo_sensors.%I owner to svitlo_sensor_owner',t);
 end loop;
 foreach f in array array['svitlo_sensors.packet(uuid,integer,uuid)'::regprocedure,'svitlo_sensors.phone_command(text,jsonb)'::regprocedure,'svitlo_sensors.admin_factory_phone(uuid,text,text,text)'::regprocedure,'svitlo_sensors.phone_signal(uuid,integer)'::regprocedure,'svitlo_sensors.phone_ingest(jsonb,text)'::regprocedure,'svitlo_sensors.phone_history(uuid,integer,date)'::regprocedure,'svitlo_sensors.phone_relocate(jsonb)'::regprocedure,'svitlo_sensors.phone_cleanup()'::regprocedure] loop execute format('revoke all on function %s from public',f);execute format('alter function %s owner to svitlo_sensor_owner',f);end loop;
end $$;
grant execute on function svitlo_sensors.phone_command(text,jsonb),svitlo_sensors.phone_signal(uuid,integer),svitlo_sensors.phone_ingest(jsonb,text),svitlo_sensors.phone_history(uuid,integer,date) to svitlo_stage_api;
grant execute on function svitlo_sensors.phone_relocate(jsonb) to svitlo_stage_api;
grant execute on function svitlo_sensors.phone_cleanup() to svitlo_stage_worker;
