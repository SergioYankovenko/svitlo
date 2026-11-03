-- Plan232: identity/access only. No physical telemetry or public sensor endpoint.
do $$ begin if not exists(select 1 from pg_roles where rolname='svitlo_sensor_owner') then create role svitlo_sensor_owner nologin nobypassrls;end if;end $$;
create schema svitlo_sensors authorization svitlo_sensor_owner;
revoke all on schema svitlo_sensors from public;
grant usage on schema svitlo_sensors to svitlo_stage_api,svitlo_stage_worker;
grant usage on schema auth,public,svitlo_vps to svitlo_sensor_owner;
grant execute on function auth.uid(),svitlo_vps.catalog_allowed(uuid) to svitlo_sensor_owner;
grant select on public.svitlo_profiles,svitlo_vps.catalog,svitlo_vps.catalog_exclusions,svitlo_vps.address_lines to svitlo_sensor_owner;
create policy sensor_profile_lookup on public.svitlo_profiles to svitlo_sensor_owner using(owner=auth.uid());
create table svitlo_sensors.policy(id boolean primary key default true check(id),max_sensors integer not null default 10 check(max_sensors between 1 and 10),max_viewers integer not null default 20 check(max_viewers between 1 and 100),max_pending integer not null default 5 check(max_pending between 1 and 20),invite_seconds integer not null default 900 check(invite_seconds between 60 and 3600));
insert into svitlo_sensors.policy(id) values(true);
create table svitlo_sensors.rates(subject uuid primary key references auth.users on delete cascade,started_at timestamptz not null,count integer not null);
create table svitlo_sensors.devices (
 sensor_id uuid primary key default gen_random_uuid(),is_test boolean not null default true check(is_test),
 status text not null default 'unclaimed' check(status in ('unclaimed','bound','disabled')),
 current_epoch integer not null default 0 check(current_epoch>=0),access_revision bigint not null default 1,
 claim_hash text unique check(claim_hash is null or claim_hash ~ '^[a-f0-9]{64}$'),claim_expires_at timestamptz not null,created_at timestamptz not null default now()
);
create index sensor_claim_expiry on svitlo_sensors.devices(claim_expires_at) where claim_hash is not null;
create table svitlo_sensors.bindings (
 binding_id uuid primary key default gen_random_uuid(),sensor_id uuid not null references svitlo_sensors.devices,
 epoch integer not null,point_id uuid not null unique default gen_random_uuid(),owner_subject uuid not null references auth.users,
 address_id uuid not null references svitlo_vps.catalog,line_id uuid references svitlo_vps.address_lines,
 bound_at timestamptz not null default now(),ended_at timestamptz,unique(sensor_id,epoch)
);
create unique index sensor_one_binding on svitlo_sensors.bindings(sensor_id) where ended_at is null;
create index sensor_binding_owner on svitlo_sensors.bindings(owner_subject);
create index sensor_binding_address on svitlo_sensors.bindings(address_id);
create table svitlo_sensors.memberships (
 member_id uuid primary key default gen_random_uuid(),binding_id uuid not null references svitlo_sensors.bindings,
 subject uuid not null references auth.users,role text not null check(role in ('owner','viewer')),
 created_at timestamptz not null default now(),revoked_at timestamptz
);
create unique index sensor_member_active on svitlo_sensors.memberships(binding_id,subject) where revoked_at is null;
create unique index sensor_single_owner on svitlo_sensors.memberships(binding_id) where revoked_at is null and role='owner';
create index sensor_subject_active on svitlo_sensors.memberships(subject,binding_id) where revoked_at is null;
create index sensor_member_subject on svitlo_sensors.memberships(subject);
create index sensor_member_binding on svitlo_sensors.memberships(binding_id);
create table svitlo_sensors.reader_links (
 member_id uuid primary key references svitlo_sensors.memberships on delete cascade,
 profile_id uuid not null unique references public.svitlo_profiles on delete cascade,created_at timestamptz not null default now()
);
create table svitlo_sensors.invitations (
 invite_id uuid primary key default gen_random_uuid(),binding_id uuid not null references svitlo_sensors.bindings,
 created_by uuid not null references auth.users,nonce uuid not null,token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),expires_at timestamptz not null,revoked_at timestamptz,
 consumed_at timestamptz,consumed_by uuid references auth.users,consumed_member uuid references svitlo_sensors.memberships
);
create index sensor_invite_pending on svitlo_sensors.invitations(binding_id,expires_at) where revoked_at is null and consumed_at is null;
create index sensor_invite_binding on svitlo_sensors.invitations(binding_id);
create index sensor_invite_creator on svitlo_sensors.invitations(created_by);
create index sensor_invite_consumer on svitlo_sensors.invitations(consumed_by) where consumed_by is not null;
create table svitlo_sensors.commands (
 subject uuid not null references auth.users,request_id uuid not null,operation text not null,packet_hash text not null,refs jsonb not null,
 created_at timestamptz not null default now(),primary key(subject,request_id)
);
create index sensor_command_expiry on svitlo_sensors.commands(created_at);
create table svitlo_sensors.audit (
 audit_id uuid primary key default gen_random_uuid(),occurred_at timestamptz not null default now(),
 actor_subject uuid references auth.users,operation text not null,sensor_id uuid,epoch integer
);
create index sensor_audit_expiry on svitlo_sensors.audit(occurred_at);
create index sensor_audit_actor on svitlo_sensors.audit(actor_subject);
create function svitlo_sensors.take_rate(subject uuid) returns boolean language sql volatile set search_path='' as $$
 insert into svitlo_sensors.rates as r values($1,clock_timestamp(),1) on conflict(subject) do update set
 count=case when r.started_at<clock_timestamp()-interval '1 minute' then 1 else r.count+1 end,
 started_at=case when r.started_at<clock_timestamp()-interval '1 minute' then clock_timestamp() else r.started_at end returning count<=120
$$;

create function svitlo_sensors.packet(sensor uuid,binding_epoch integer,subject uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('sensorId',d.sensor_id,'bindingEpoch',b.epoch,'measurementPointId',b.point_id,'canonicalAddressId',b.address_id,'lineId',b.line_id,
 'membershipId',m.member_id,'role',m.role,'accessRevision',d.access_revision,'readerProfileId',l.profile_id,'isTest',d.is_test,
 'capabilities',jsonb_build_object('identity',true,'telemetry',false,'ingest',false,'prediction',false,'transfer',false,'recovery',false,'entitlement','not_configured'))
 from svitlo_sensors.devices d join svitlo_sensors.bindings b on b.sensor_id=d.sensor_id and b.epoch=d.current_epoch and b.ended_at is null
 join svitlo_sensors.memberships m on m.binding_id=b.binding_id and m.subject=$3 and m.revoked_at is null
 left join svitlo_sensors.reader_links l on l.member_id=m.member_id
 where d.sensor_id=$1 and b.epoch=$2 and d.status='bound'
$$;
create function svitlo_sensors.command(op text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare actor uuid:=auth.uid();allowed text[];required text[];k text;cfg svitlo_sensors.policy;
 d svitlo_sensors.devices;b svitlo_sensors.bindings;m svitlo_sensors.memberships;i svitlo_sensors.invitations;r svitlo_sensors.commands;
 profile public.svitlo_profiles;sid uuid;epoch integer;view jsonb;result jsonb;refs jsonb;hash text;is_owner boolean;begin
 if actor is null then raise insufficient_privilege;end if;
 case op
 when 'list' then allowed:=array[]::text[];required:=allowed;
 when 'get','members' then allowed:=array['sensorId','bindingEpoch'];required:=allowed;
 when 'claim' then allowed:=array['requestId','claimHash','profileId'];required:=allowed;
 when 'invite_create' then allowed:=array['requestId','sensorId','bindingEpoch','nonce','tokenHash'];required:=allowed;
 when 'invite_inspect' then allowed:=array['inviteHash'];required:=allowed;
 when 'invite_accept' then allowed:=array['requestId','inviteHash','profileId'];required:=allowed;
 when 'invite_revoke' then allowed:=array['requestId','sensorId','bindingEpoch','inviteId'];required:=allowed;
 when 'member_revoke','leave' then allowed:=array['requestId','sensorId','bindingEpoch','membershipId'];required:=allowed;
 when 'link' then allowed:=array['requestId','sensorId','bindingEpoch','profileId'];required:=allowed;
 when 'disconnect' then allowed:=array['requestId','sensorId','bindingEpoch','confirmed'];required:=allowed;
 else return jsonb_build_object('http',400,'code','unknown_sensor_operation');end case;
 if p is null or jsonb_typeof(p) is distinct from 'object' then return jsonb_build_object('http',400,'code','invalid_sensor_packet');end if;
 if p-allowed<>'{}'::jsonb or not(p ?& required) or octet_length(p::text)>4096 then return jsonb_build_object('http',400,'code','invalid_sensor_packet');end if;
 foreach k in array allowed loop
  if k in ('requestId','sensorId','profileId','inviteId','membershipId','nonce') then
   if jsonb_typeof(p->k)<>'string' or (p->>k)!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return jsonb_build_object('http',400,'code','invalid_sensor_id');end if;
  elsif k in ('claimHash','tokenHash','inviteHash') then
   if jsonb_typeof(p->k)<>'string' or (p->>k)!~'^[a-f0-9]{64}$' then return jsonb_build_object('http',400,'code','invalid_sensor_proof');end if;
  elsif k='bindingEpoch' then
   if jsonb_typeof(p->k)<>'number' or (p->>k)!~'^[1-9][0-9]{0,8}$' then return jsonb_build_object('http',400,'code','invalid_sensor_epoch');end if;
  elsif k='confirmed' and p->k<>'true'::jsonb then return jsonb_build_object('http',409,'code','explicit_disconnect_confirmation_required');end if;
 end loop;
 if not svitlo_sensors.take_rate(actor) then return jsonb_build_object('http',429,'code','sensor_request_limit');end if;
 if op='list' then
  select coalesce(jsonb_agg(svitlo_sensors.packet(s.sensor_id,s.epoch,actor)),'[]') into result from(
   select sb.sensor_id,sb.epoch from svitlo_sensors.memberships sm join svitlo_sensors.bindings sb using(binding_id) where sm.subject=actor and sm.revoked_at is null and sb.ended_at is null order by sm.created_at limit 10) s;
  return jsonb_build_object('http',200,'schemaVersion',1,'sensors',result,'complete',true);
 end if;
 if p ? 'sensorId' then sid:=(p->>'sensorId')::uuid;epoch:=(p->>'bindingEpoch')::integer;end if;
 if op='get' then view:=svitlo_sensors.packet(sid,epoch,actor);return case when view is null then jsonb_build_object('http',404,'code','sensor_not_available') else jsonb_build_object('http',200,'schemaVersion',1,'sensor',view) end;end if;
 if op='invite_inspect' then
  select x.* into i from svitlo_sensors.invitations x join svitlo_sensors.bindings sb using(binding_id) join svitlo_sensors.devices sd using(sensor_id)
   where x.token_hash=p->>'inviteHash' and x.revoked_at is null and x.consumed_at is null and x.expires_at>now() and sb.ended_at is null and sb.epoch=sd.current_epoch and sd.status='bound';
  if not found then return jsonb_build_object('http',404,'code','invite_not_available');end if;
  select * into b from svitlo_sensors.bindings where binding_id=i.binding_id;
  return jsonb_build_object('http',200,'schemaVersion',1,'invitation',jsonb_build_object('inviteId',i.invite_id,'sensorId',b.sensor_id,'bindingEpoch',b.epoch,'canonicalAddressId',b.address_id,'lineId',b.line_id,'role','viewer','expiresAt',i.expires_at));
 end if;
 -- All low-frequency management writes serialize; telemetry will use a separate future ingest path.
 if op<>'members' then perform pg_advisory_xact_lock(311032106);end if;
 select * into cfg from svitlo_sensors.policy where id;
 if p ? 'requestId' then
  hash:=encode(sha256(convert_to((case when op='invite_create' then p-array['nonce','tokenHash'] else p end)::text,'UTF8')),'hex');
  select * into r from svitlo_sensors.commands where subject=actor and request_id=(p->>'requestId')::uuid;
  if found then
   if r.operation<>op or r.packet_hash<>hash then return jsonb_build_object('http',409,'code','sensor_request_id_conflict');end if;
   if op in ('claim','invite_accept','link') then
    view:=svitlo_sensors.packet((r.refs->>'sensorId')::uuid,(r.refs->>'epoch')::integer,actor);
    if view is null or view->>'membershipId'<>r.refs->>'memberId' then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
    return jsonb_build_object('http',200,'schemaVersion',1,'sensor',view,'duplicate',true);
   elsif op<>'invite_create' then return jsonb_build_object('http',200,'schemaVersion',1,'completed',true,'duplicate',true);
   end if;
  end if;
 end if;
 if op not in ('claim','invite_accept') then
  view:=svitlo_sensors.packet(sid,epoch,actor);
  if view is null then return jsonb_build_object('http',404,'code','sensor_not_available');end if;
  select * into b from svitlo_sensors.bindings where sensor_id=sid and svitlo_sensors.bindings.epoch=epoch;
  select * into m from svitlo_sensors.memberships where member_id=(view->>'membershipId')::uuid;
  is_owner:=m.role='owner';
  if op in ('members','invite_create','invite_revoke','member_revoke','disconnect') and not is_owner then return jsonb_build_object('http',403,'code','sensor_owner_required');end if;
 end if;
 if op='members' then
  return jsonb_build_object('http',200,'schemaVersion',1,'members',(select coalesce(jsonb_agg(jsonb_build_object('membershipId',member_id,'role',role,'joinedAt',created_at)),'[]') from svitlo_sensors.memberships where binding_id=b.binding_id and revoked_at is null),
   'invitations',(select coalesce(jsonb_agg(jsonb_build_object('inviteId',invite_id,'expiresAt',expires_at)),'[]') from svitlo_sensors.invitations where binding_id=b.binding_id and consumed_at is null and revoked_at is null and expires_at>now()));
 end if;
 if op in ('claim','invite_accept','link') then
  select * into profile from public.svitlo_profiles where id=(p->>'profileId')::uuid and owner=actor;
  if not found then return jsonb_build_object('http',404,'code','profile_not_available');end if;
  if coalesce(profile.address->>'canonicalAddressId','')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return jsonb_build_object('http',409,'code','profile_requires_canonical_address');end if;
  if profile.address->>'lineId' is not null and (profile.address->>'lineId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return jsonb_build_object('http',409,'code','profile_line_not_available');end if;
  if exists(select 1 from svitlo_sensors.reader_links where profile_id=profile.id) and op<>'link' then return jsonb_build_object('http',409,'code','profile_already_has_sensor');end if;
 end if;
 if op='claim' then
  select * into d from svitlo_sensors.devices where claim_hash=p->>'claimHash' and claim_expires_at>now() and status='unclaimed';
  if not found then return jsonb_build_object('http',404,'code','claim_not_available');end if;
  if (select count(*) from svitlo_sensors.memberships where subject=actor and revoked_at is null)>=cfg.max_sensors then return jsonb_build_object('http',409,'code','sensor_membership_limit');end if;
  if not exists(select 1 from svitlo_vps.catalog where id=(profile.address->>'canonicalAddressId')::uuid and kind='address') or not svitlo_vps.catalog_allowed((profile.address->>'canonicalAddressId')::uuid) then return jsonb_build_object('http',409,'code','profile_requires_reselection');end if;
  if profile.address->>'lineId' is not null and not exists(select 1 from svitlo_vps.address_lines where id=(profile.address->>'lineId')::uuid and address_id=(profile.address->>'canonicalAddressId')::uuid and active) then return jsonb_build_object('http',409,'code','profile_line_not_available');end if;
  update svitlo_sensors.devices set current_epoch=current_epoch+1,status='bound',access_revision=access_revision+1 where sensor_id=d.sensor_id returning * into d;
  insert into svitlo_sensors.bindings(sensor_id,epoch,owner_subject,address_id,line_id) values(d.sensor_id,d.current_epoch,actor,(profile.address->>'canonicalAddressId')::uuid,(profile.address->>'lineId')::uuid) returning * into b;
  insert into svitlo_sensors.memberships(binding_id,subject,role) values(b.binding_id,actor,'owner') returning * into m;
  insert into svitlo_sensors.reader_links(member_id,profile_id) values(m.member_id,profile.id);sid:=d.sensor_id;epoch:=b.epoch;
 elsif op='invite_create' then
  if r.request_id is not null then select * into i from svitlo_sensors.invitations where invite_id=(r.refs->>'inviteId')::uuid;
  else
   if (select count(*) from svitlo_sensors.invitations where binding_id=b.binding_id and revoked_at is null and consumed_at is null and expires_at>now())>=cfg.max_pending then return jsonb_build_object('http',429,'code','pending_invite_limit');end if;
   insert into svitlo_sensors.invitations(binding_id,created_by,nonce,token_hash,expires_at) values(b.binding_id,actor,(p->>'nonce')::uuid,p->>'tokenHash',now()+cfg.invite_seconds*interval '1 second') returning * into i;
  end if;
  if i.invite_id is null or i.revoked_at is not null or i.consumed_at is not null or i.expires_at<=now() then return jsonb_build_object('http',409,'code','invite_not_available');end if;
  result:=jsonb_build_object('http',200,'schemaVersion',1,'invitation',jsonb_build_object('inviteId',i.invite_id,'sensorId',sid,'bindingEpoch',epoch,'role','viewer','expiresAt',i.expires_at),'privateNonce',i.nonce,'privateHash',i.token_hash);
 elsif op='invite_accept' then
  select * into i from svitlo_sensors.invitations where token_hash=p->>'inviteHash';
  if not found or i.revoked_at is not null then return jsonb_build_object('http',404,'code','invite_not_available');end if;
  select x.* into b from svitlo_sensors.bindings x join svitlo_sensors.devices sd using(sensor_id) where binding_id=i.binding_id and x.ended_at is null and x.epoch=sd.current_epoch and sd.status='bound';
  if not found then return jsonb_build_object('http',404,'code','invite_not_available');end if;
  if i.consumed_at is not null then return jsonb_build_object('http',409,'code','invite_already_used');end if;
  if i.expires_at<=now() then return jsonb_build_object('http',404,'code','invite_not_available');end if;
  if (profile.address->>'canonicalAddressId')::uuid<>b.address_id or (profile.address->>'lineId')::uuid is distinct from b.line_id then return jsonb_build_object('http',409,'code','sensor_profile_address_mismatch');end if;
  if exists(select 1 from svitlo_sensors.memberships where binding_id=b.binding_id and subject=actor and revoked_at is null) then return jsonb_build_object('http',409,'code','already_sensor_member');end if;
  if (select count(*) from svitlo_sensors.memberships where subject=actor and revoked_at is null)>=cfg.max_sensors or (select count(*) from svitlo_sensors.memberships where binding_id=b.binding_id and role='viewer' and revoked_at is null)>=cfg.max_viewers then return jsonb_build_object('http',409,'code','sensor_membership_limit');end if;
  insert into svitlo_sensors.memberships(binding_id,subject,role) values(b.binding_id,actor,'viewer') returning * into m;
  insert into svitlo_sensors.reader_links(member_id,profile_id) values(m.member_id,profile.id);
  update svitlo_sensors.invitations set consumed_at=now(),consumed_by=actor,consumed_member=m.member_id where invite_id=i.invite_id;sid:=b.sensor_id;epoch:=b.epoch;
  update svitlo_sensors.devices set access_revision=access_revision+1 where sensor_id=sid;
 elsif op='link' then
  if (profile.address->>'canonicalAddressId')::uuid<>b.address_id or (profile.address->>'lineId')::uuid is distinct from b.line_id then return jsonb_build_object('http',409,'code','sensor_profile_address_mismatch');end if;
  if exists(select 1 from svitlo_sensors.reader_links where profile_id=profile.id and member_id<>m.member_id) then return jsonb_build_object('http',409,'code','profile_already_has_sensor');end if;
  if exists(select 1 from svitlo_sensors.reader_links where member_id=m.member_id and profile_id<>profile.id) then return jsonb_build_object('http',409,'code','sensor_already_linked');end if;
  insert into svitlo_sensors.reader_links(member_id,profile_id) values(m.member_id,profile.id) on conflict(member_id) do nothing;
 elsif op='invite_revoke' then
  update svitlo_sensors.invitations set revoked_at=coalesce(revoked_at,now()) where invite_id=(p->>'inviteId')::uuid and binding_id=b.binding_id;
  if not found then return jsonb_build_object('http',404,'code','invite_not_available');end if;
 elsif op in ('member_revoke','leave') then
  select * into m from svitlo_sensors.memberships where member_id=(p->>'membershipId')::uuid and binding_id=b.binding_id;
  if not found or (op='leave' and m.subject<>actor) then return jsonb_build_object('http',404,'code','member_not_available');end if;
  if m.role='owner' then return jsonb_build_object('http',409,'code','owner_requires_disconnect');end if;
  update svitlo_sensors.memberships set revoked_at=coalesce(revoked_at,now()) where member_id=m.member_id;delete from svitlo_sensors.reader_links where member_id=m.member_id;
  update svitlo_sensors.devices set access_revision=access_revision+1 where sensor_id=sid;
 elsif op='disconnect' then
  update svitlo_sensors.bindings set ended_at=now() where binding_id=b.binding_id;
  update svitlo_sensors.memberships set revoked_at=coalesce(revoked_at,now()) where binding_id=b.binding_id;
  delete from svitlo_sensors.reader_links where member_id in(select member_id from svitlo_sensors.memberships where binding_id=b.binding_id);
  update svitlo_sensors.invitations set revoked_at=coalesce(revoked_at,now()) where binding_id=b.binding_id;
  update svitlo_sensors.devices set status='disabled',claim_hash=null,access_revision=access_revision+1 where sensor_id=sid;
 end if;
 refs:=jsonb_build_object('sensorId',sid,'epoch',epoch,'memberId',m.member_id,'inviteId',i.invite_id);
 if r.request_id is null then
  insert into svitlo_sensors.commands(subject,request_id,operation,packet_hash,refs) values(actor,(p->>'requestId')::uuid,op,hash,refs);
  insert into svitlo_sensors.audit(actor_subject,operation,sensor_id,epoch) values(actor,op,sid,epoch);
  delete from svitlo_sensors.audit where audit_id in(select audit_id from svitlo_sensors.audit order by occurred_at desc offset 10000 limit 1000);
 end if;
 if result is not null then return result;end if;
 if op in ('claim','invite_accept','link') then return jsonb_build_object('http',200,'schemaVersion',1,'sensor',svitlo_sensors.packet(sid,epoch,actor));end if;
 return jsonb_build_object('http',200,'schemaVersion',1,'completed',true);
end $$;

create function svitlo_sensors.admin_provision(hash text,sensor uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare d svitlo_sensors.devices;begin
 if hash is null or hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid bootstrap hash';end if;
 perform pg_advisory_xact_lock(311032106);
 if sensor is null then insert into svitlo_sensors.devices(claim_hash,claim_expires_at) values(hash,now()+interval '24 hours') returning * into d;
 else update svitlo_sensors.devices set claim_hash=hash,claim_expires_at=now()+interval '24 hours',status='unclaimed' where sensor_id=sensor and is_test and status<>'bound' returning * into d;
  if not found then raise exception 'Only disabled/unclaimed test identity may be reissued';end if;
 end if;
 insert into svitlo_sensors.audit(operation,sensor_id,epoch) values('admin_provision_test',d.sensor_id,d.current_epoch);
 return jsonb_build_object('sensorId',d.sensor_id,'isTest',true,'claimExpiresAt',d.claim_expires_at);
end $$;
create function svitlo_sensors.admin_purge_test(sensor uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(311032106);
 if not exists(select 1 from svitlo_sensors.devices where sensor_id=sensor and is_test and status<>'bound') then raise exception 'Only inactive test identity may be purged';end if;
 delete from svitlo_sensors.invitations where binding_id in(select binding_id from svitlo_sensors.bindings where sensor_id=sensor);
 delete from svitlo_sensors.memberships where binding_id in(select binding_id from svitlo_sensors.bindings where sensor_id=sensor);
 delete from svitlo_sensors.bindings where sensor_id=sensor;delete from svitlo_sensors.devices where sensor_id=sensor;
 insert into svitlo_sensors.audit(operation,sensor_id) values('admin_purge_test',sensor);
end $$;
create function svitlo_sensors.cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare receipts integer;begin
 delete from svitlo_sensors.rates where subject in(select subject from svitlo_sensors.rates where started_at<now()-interval '1 day' limit 1000);
 delete from svitlo_sensors.commands where (subject,request_id) in(select subject,request_id from svitlo_sensors.commands where created_at<now()-interval '30 days' limit 1000);get diagnostics receipts=row_count;
 delete from svitlo_sensors.invitations where invite_id in(select invite_id from svitlo_sensors.invitations where expires_at<now()-interval '30 days' limit 1000);
 update svitlo_sensors.devices set claim_hash=null,status=case when status='unclaimed' then 'disabled' else status end where sensor_id in(select sensor_id from svitlo_sensors.devices where claim_hash is not null and claim_expires_at<now() limit 1000);
 delete from svitlo_sensors.audit where audit_id in(select audit_id from svitlo_sensors.audit where occurred_at<now()-interval '90 days' order by occurred_at limit 1000);
 delete from svitlo_sensors.audit where audit_id in(select audit_id from svitlo_sensors.audit order by occurred_at desc offset 10000 limit 1000);
 return jsonb_build_object('receipts',receipts);
end $$;
do $$ declare t text;f record;begin
 foreach t in array array['policy','rates','devices','bindings','memberships','reader_links','invitations','commands','audit'] loop
  execute format('alter table svitlo_sensors.%I enable row level security',t);execute format('revoke all on table svitlo_sensors.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);execute format('alter table svitlo_sensors.%I owner to svitlo_sensor_owner',t);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='svitlo_sensors' loop execute format('revoke all on function %s from public',f.signature);execute format('alter function %s owner to svitlo_sensor_owner',f.signature);end loop;
end $$;
grant execute on function svitlo_sensors.command(text,jsonb) to svitlo_stage_api;
grant execute on function svitlo_sensors.cleanup() to svitlo_stage_worker;
-- Keep durable sensor identities after local/server profile deletion; losing a session is not recovery proof.
create or replace function svitlo_vps.session_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare removed integer;begin
 delete from svitlo_vps.sessions where token_hash in(select token_hash from svitlo_vps.sessions where expires_at<now() limit 1000);get diagnostics removed=row_count;
 delete from auth.users where id in(select u.id from auth.users u where u.created_at<now()-interval '30 days'
 and not exists(select 1 from svitlo_vps.sessions s where s.owner=u.id) and not exists(select 1 from public.svitlo_profiles p where p.owner=u.id)
 and not exists(select 1 from svitlo_sensors.memberships m where m.subject=u.id) and not exists(select 1 from svitlo_sensors.bindings b where b.owner_subject=u.id)
 and not exists(select 1 from svitlo_sensors.invitations i where i.created_by=u.id or i.consumed_by=u.id) and not exists(select 1 from svitlo_sensors.commands c where c.subject=u.id)
 and not exists(select 1 from svitlo_sensors.audit a where a.actor_subject=u.id) limit 1000);
 return jsonb_build_object('expiredSessions',removed);
end $$;

-- Add metadata-only sensor access failures to BE-05, without rewriting applied1004.
alter table svitlo_telemetry.security_events drop constraint security_events_operation_check;
alter table svitlo_telemetry.security_events add constraint security_events_operation_check check(operation in ('catalog_lookup','profile_write','diagnostic_report','sensor_access'));
create or replace function svitlo_telemetry.record_security(p jsonb) returns text language plpgsql security definer set search_path='' as $$
declare cfg svitlo_telemetry.policy;begin
 if p is null or jsonb_typeof(p) is distinct from 'object' then return 'invalid';end if;
 if p-array['operation','field','reason','confidence','source','correlationId']<>'{}'::jsonb or not(p ?& array['operation','field','reason','confidence','source'])
 or coalesce(p->>'operation','') not in ('catalog_lookup','profile_write','diagnostic_report','sensor_access') or coalesce(p->>'field','') not in ('city','street','house','name','request') or coalesce(p->>'reason','') not in ('schema','size','control','operation','owner','rate')
 or coalesce(p->>'confidence','') not in ('schema_violation','heuristic') or coalesce(p->>'source','') not in ('api','edge','database') then return 'invalid';end if;
 if p ? 'correlationId' and (jsonb_typeof(p->'correlationId')<>'string' or (p->>'correlationId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') then return 'invalid';end if;
 if not pg_try_advisory_xact_lock(311032105) then return 'busy';end if;
 select * into cfg from svitlo_telemetry.policy where id;
 if not cfg.security_enabled then return 'disabled';end if;
 if exists(select 1 from svitlo_telemetry.security_events where operation=p->>'operation' and field=p->>'field' and reason=p->>'reason' and occurred_at>now()-interval '60 seconds') then return 'duplicate';end if;
 if (select count(*) from svitlo_telemetry.security_events where occurred_at>now()-interval '1 minute')>=cfg.security_per_minute then return 'rate';end if;
 if (select count(*) from svitlo_telemetry.security_events where occurred_at>now()-interval '14 days')>=cfg.security_capacity then return 'capacity';end if;
 insert into svitlo_telemetry.security_events(operation,field,reason,confidence,source,correlation_id) values(p->>'operation',p->>'field',p->>'reason',p->>'confidence',p->>'source',(p->>'correlationId')::uuid);
 return 'stored';
end $$;

