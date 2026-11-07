-- Separate administrative origin/role. No arbitrary SQL, shell or credentials.
do $$ begin
 if not exists(select from pg_roles where rolname='svitlo_admin_owner') then create role svitlo_admin_owner nologin nobypassrls;end if;
 if not exists(select from pg_roles where rolname='svitlo_stage_admin') then create role svitlo_stage_admin nologin nobypassrls connection limit 2;end if;
end $$;
create schema svitlo_admin authorization svitlo_admin_owner;revoke all on schema svitlo_admin from public;
create table svitlo_admin.principals(id uuid primary key default gen_random_uuid(),label text not null check(length(label) between 1 and 120),roles text[] not null check(cardinality(roles)>0 and roles<@array['owner','read-only','operator','support','billing-admin']),disabled boolean not null default false);
create table svitlo_admin.tickets(proof_hash text primary key check(proof_hash~'^[a-f0-9]{64}$'),principal_id uuid not null references svitlo_admin.principals,expires_at timestamptz not null);
create table svitlo_admin.sessions(token_hash text primary key check(token_hash~'^[a-f0-9]{64}$'),principal_id uuid not null references svitlo_admin.principals,expires_at timestamptz not null);
create table svitlo_admin.commands(request_id uuid primary key,actor uuid not null references svitlo_admin.principals,kind text not null,target text not null,reason text not null check(length(reason) between 8 and 500),packet jsonb not null,result jsonb not null,created_at timestamptz not null default clock_timestamp());
create index admin_commands_time on svitlo_admin.commands(created_at desc,request_id);
create table svitlo_admin.source_pauses(source_id text primary key references svitlo_sources.registry(id),until_at timestamptz not null);
create table svitlo_admin.account_blocks(account_id uuid primary key references auth.users on delete cascade,until_at timestamptz not null);
create table svitlo_admin.device_blocks(sensor_id uuid primary key references svitlo_sensors.devices on delete cascade,until_at timestamptz not null);
do $$ declare t text;begin foreach t in array array['principals','tickets','sessions','commands','source_pauses','account_blocks','device_blocks'] loop execute 'alter table svitlo_admin.'||t||' owner to svitlo_admin_owner';execute 'revoke all on svitlo_admin.'||t||' from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session,svitlo_stage_admin';end loop;end $$;
grant usage on schema svitlo_sources,svitlo_events,svitlo_discovery,svitlo_vps,svitlo_sensors,svitlo_catalog,auth to svitlo_admin_owner;
grant select on svitlo_sources.registry,svitlo_sources.state,svitlo_events.deliveries,svitlo_discovery.regional_sources,svitlo_catalog.binding_reviews,svitlo_vps.worker_cycle to svitlo_admin_owner;
create policy admin_worker_read on svitlo_vps.worker_cycle for select to svitlo_admin_owner using(true);
create policy admin_source_read on svitlo_discovery.regional_sources for select to svitlo_admin_owner using(true);
grant select(sensor_id,status,current_epoch,created_at) on svitlo_sensors.devices to svitlo_admin_owner;
create policy admin_device_read on svitlo_sensors.devices for select to svitlo_admin_owner using(true);
grant select on svitlo_sensors.main_app_subscriptions to svitlo_admin_owner;
create policy admin_subscription_read on svitlo_sensors.main_app_subscriptions for select to svitlo_admin_owner using(true);
grant select(id,created_at) on auth.users to svitlo_admin_owner;
grant select,delete on svitlo_vps.sessions to svitlo_admin_owner;
grant execute on function svitlo_events.replay_delivery(uuid,uuid,uuid,text) to svitlo_admin_owner;
create function svitlo_admin.login(proof text,new_hash text) returns boolean language plpgsql security definer set search_path='' as $$
declare principal uuid;begin
 if proof!~'^[a-f0-9]{64}$' or new_hash!~'^[a-f0-9]{64}$' then return false;end if;
 delete from svitlo_admin.tickets t where t.proof_hash=proof and t.expires_at>clock_timestamp() and exists(select from svitlo_admin.principals p where p.id=t.principal_id and not p.disabled) returning principal_id into principal;
 if not found then return false;end if;
 insert into svitlo_admin.sessions values(new_hash,principal,clock_timestamp()+interval '30 minutes');return true;
end $$;
create function svitlo_admin.principal(proof text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'label',p.label,'roles',p.roles,'expiresAt',s.expires_at) from svitlo_admin.sessions s join svitlo_admin.principals p on p.id=s.principal_id where s.token_hash=proof and s.expires_at>clock_timestamp() and not p.disabled
$$;
create function svitlo_admin.logout(proof text) returns void language sql security definer set search_path='' as $$delete from svitlo_admin.sessions where token_hash=proof$$;
create function svitlo_admin.source_allowed(source_key text) returns boolean language sql stable security definer set search_path='' as $$select not exists(select from svitlo_admin.source_pauses where source_id=source_key and until_at>clock_timestamp())$$;
create function svitlo_admin.account_allowed(subject uuid) returns boolean language sql stable security definer set search_path='' as $$select not exists(select from svitlo_admin.account_blocks where account_id=subject and until_at>clock_timestamp())$$;
create function svitlo_admin.device_allowed(sensor uuid) returns boolean language sql stable security definer set search_path='' as $$select not exists(select from svitlo_admin.device_blocks where sensor_id=sensor and until_at>clock_timestamp())$$;
create function svitlo_admin.list(proof text,resource text,page_size integer,page_offset integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb;rows jsonb;total bigint;begin
 p:=svitlo_admin.principal(proof);if p is null then raise insufficient_privilege using message='admin session required';end if;
 if page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset not between 0 and 10000 then raise exception 'invalid admin page';end if;
 if resource in('accounts','devices') and not (p->'roles' ?| array['owner','support']) or resource='subscriptions' and not(p->'roles' ?| array['owner','support','billing-admin']) then raise insufficient_privilege using message='admin role required';end if;
 if resource='sources' then
  select count(*) into total from svitlo_sources.registry;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select r.id,r.label,r.family,r.verification_state,s.last_attempt_at,s.last_success_at,s.last_outcome,z.until_at paused_until from svitlo_sources.registry r left join svitlo_sources.state s on s.source_id=r.id left join svitlo_admin.source_pauses z on z.source_id=r.id order by r.id limit page_size offset page_offset) x;
 elsif resource='collectors' then
  select count(*) into total from svitlo_discovery.regional_sources;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select operator_id id,enabled,status,last_attempt_at,last_success_at,next_at,error_code from svitlo_discovery.regional_sources order by operator_id limit page_size offset page_offset) x;
 elsif resource='workers' then
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select 'main' id,last_attempt,last_success,last_failure,error_code from svitlo_vps.worker_cycle) x;total:=jsonb_array_length(rows);
 elsif resource='jobs' then
  select count(*) into total from svitlo_events.deliveries;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select id,consumer,state,attempts,next_at,error_code,finished_at from svitlo_events.deliveries order by next_at,id limit page_size offset page_offset) x;
 elsif resource='reviews' then
  select count(*) into total from svitlo_catalog.binding_reviews;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select address_id::text||':'||reason id,address_id,reason,state,last_seen_at,observations from svitlo_catalog.binding_reviews order by last_seen_at desc,address_id,reason limit page_size offset page_offset) x;
 elsif resource='accounts' then
  select count(*) into total from auth.users;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select u.id,u.created_at,b.until_at blocked_until from auth.users u left join svitlo_admin.account_blocks b on b.account_id=u.id order by u.created_at,u.id limit page_size offset page_offset) x;
 elsif resource='subscriptions' then
  select count(*) into total from svitlo_sensors.main_app_subscriptions;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select subject id,source,valid_from,valid_until,revoked_at from svitlo_sensors.main_app_subscriptions order by subject limit page_size offset page_offset) x;
 elsif resource='devices' then
  select count(*) into total from svitlo_sensors.devices;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select d.sensor_id id,d.status,d.current_epoch,d.created_at,b.until_at blocked_until from svitlo_sensors.devices d left join svitlo_admin.device_blocks b using(sensor_id) order by d.sensor_id limit page_size offset page_offset) x;
 elsif resource='audit' then
  if not (p->'roles' ?| array['owner','operator','billing-admin']) then raise insufficient_privilege using message='admin role required';end if;
  select count(*) into total from svitlo_admin.commands;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select request_id id,actor,kind,target,reason,result,created_at from svitlo_admin.commands order by created_at desc,request_id limit page_size offset page_offset) x;
 else raise exception 'unknown admin resource';end if;
 return jsonb_build_object('data',rows,'total',total);
end $$;
create function svitlo_admin.command(proof text,request uuid,command_kind text,command_target text,why text,data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb;actor_id uuid;prior svitlo_admin.commands;result jsonb;packet jsonb;until_time timestamptz;begin
 -- Lock the principal/session for the whole command; roles come from the DB.
 perform 1 from svitlo_admin.sessions s join svitlo_admin.principals a on a.id=s.principal_id where s.token_hash=proof and s.expires_at>clock_timestamp() and not a.disabled for share of s,a;
 p:=svitlo_admin.principal(proof);if p is null then raise insufficient_privilege using message='admin session required';end if;actor_id:=(p->>'id')::uuid;
 if request is null or why is null or length(why) not between 8 and 500 or command_target is null or length(command_target)>200 or data is null or jsonb_typeof(data)<>'object' or octet_length(data::text)>2000 then raise exception 'invalid admin command';end if;
 if command_kind in('source.pause','source.resume','job.replay') then
  if not(p->'roles' ?| array['owner','operator']) then raise insufficient_privilege using message='operator role required';end if;
 elsif command_kind in('account.block','account.unblock','session.revoke','device.block','device.unblock') then
  if not(p->'roles' ?| array['owner','support']) then raise insufficient_privilege using message='support role required';end if;
 else raise exception 'unsupported admin command';end if;
 packet:=jsonb_build_object('kind',command_kind,'target',command_target,'reason',why,'data',data);
 perform pg_advisory_xact_lock(hashtextextended('admin-command:'||request::text,0));
 select * into prior from svitlo_admin.commands where request_id=request;
 if found then if prior.actor<>actor_id or prior.packet<>packet then raise exception 'admin request conflict';end if;return prior.result;end if;
 if command_kind in('source.pause','account.block','device.block') then
  if data-'until'<>'{}' or jsonb_typeof(data->'until') is distinct from 'string' then raise exception 'expiry required';end if;
  until_time:=(data->>'until')::timestamptz;if until_time<=clock_timestamp() or until_time>clock_timestamp()+interval '1 day' then raise exception 'invalid expiry';end if;
 elsif data<>'{}' then raise exception 'unexpected command fields';end if;
 if command_kind='source.pause' then insert into svitlo_admin.source_pauses values(command_target,until_time) on conflict(source_id) do update set until_at=excluded.until_at;
 elsif command_kind='source.resume' then delete from svitlo_admin.source_pauses where source_id=command_target;
 elsif command_kind='account.block' then insert into svitlo_admin.account_blocks values(command_target::uuid,until_time) on conflict(account_id) do update set until_at=excluded.until_at;delete from svitlo_vps.sessions where owner=command_target::uuid;
 elsif command_kind='account.unblock' then delete from svitlo_admin.account_blocks where account_id=command_target::uuid;
 elsif command_kind='session.revoke' then delete from svitlo_vps.sessions where owner=command_target::uuid;
 elsif command_kind='device.block' then insert into svitlo_admin.device_blocks values(command_target::uuid,until_time) on conflict(sensor_id) do update set until_at=excluded.until_at;
 elsif command_kind='device.unblock' then delete from svitlo_admin.device_blocks where sensor_id=command_target::uuid;
 elsif command_kind='job.replay' then if not svitlo_events.replay_delivery(command_target::uuid,actor_id,request,why) then raise exception 'job replay unavailable';end if;
 end if;
 result:=jsonb_build_object('id',request,'accepted',true);insert into svitlo_admin.commands(request_id,actor,kind,target,reason,packet,result) values(request,actor_id,command_kind,command_target,why,packet,result);return result;
end $$;
create function svitlo_admin.cleanup() returns void language plpgsql security definer set search_path='' as $$
begin
 delete from svitlo_admin.sessions where token_hash in(select token_hash from svitlo_admin.sessions where expires_at<clock_timestamp() limit 1000);
 delete from svitlo_admin.tickets where proof_hash in(select proof_hash from svitlo_admin.tickets where expires_at<clock_timestamp() limit 1000);
end $$;
do $$ declare f text;begin
 foreach f in array array['login(text,text)','principal(text)','logout(text)','source_allowed(text)','account_allowed(uuid)','device_allowed(uuid)','list(text,text,integer,integer)','command(text,uuid,text,text,text,jsonb)','cleanup()'] loop execute 'alter function svitlo_admin.'||f||' owner to svitlo_admin_owner';execute 'revoke all on function svitlo_admin.'||f||' from public';end loop;
end $$;
grant usage on schema svitlo_admin to svitlo_stage_admin,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session,svitlo_sensor_owner,svitlo_discovery_owner;
grant execute on function svitlo_admin.login(text,text),svitlo_admin.principal(text),svitlo_admin.logout(text),svitlo_admin.list(text,text,integer,integer),svitlo_admin.command(text,uuid,text,text,text,jsonb) to svitlo_stage_admin;
grant execute on function svitlo_admin.source_allowed(text) to svitlo_stage_api,svitlo_stage_worker,svitlo_discovery_owner;
grant execute on function svitlo_admin.account_allowed(uuid) to svitlo_stage_session;
grant execute on function svitlo_admin.device_allowed(uuid) to svitlo_sensor_owner;
grant execute on function svitlo_admin.cleanup() to svitlo_stage_worker;
-- A pause also holds background claims before a transport budget is charged.
alter function svitlo_discovery.source_available_at(text) rename to source_available_at_before_admin;
create function svitlo_discovery.source_available_at(op text) returns timestamptz language sql stable security definer set search_path='' as $$select case when svitlo_admin.source_allowed(op) then svitlo_discovery.source_available_at_before_admin(op) else 'infinity'::timestamptz end$$;
alter function svitlo_discovery.source_available_at(text) owner to svitlo_discovery_owner;revoke all on function svitlo_discovery.source_available_at(text) from public;
-- Block ingestion before any receipt, counter or measurement is committed.
alter function svitlo_sensors.phone_ingest(jsonb,text) rename to phone_ingest_before_admin;
create function svitlo_sensors.phone_ingest(p jsonb,proof text) returns jsonb language plpgsql security definer set search_path='' as $$begin
 if not svitlo_admin.device_allowed((p->>'sensorId')::uuid) then return '{"http":403,"code":"sensor_temporarily_blocked"}';end if;
 return svitlo_sensors.phone_ingest_before_admin(p,proof);
end $$;
alter function svitlo_sensors.phone_ingest(jsonb,text) owner to svitlo_sensor_owner;revoke all on function svitlo_sensors.phone_ingest_before_admin(jsonb,text) from public,svitlo_stage_api,svitlo_stage_worker;revoke all on function svitlo_sensors.phone_ingest(jsonb,text) from public;grant execute on function svitlo_sensors.phone_ingest(jsonb,text) to svitlo_stage_api;
alter function svitlo_sensors.ingest(jsonb,text) rename to ingest_before_admin;
create function svitlo_sensors.ingest(p jsonb,proof text) returns jsonb language plpgsql security definer set search_path='' as $$begin
 if not svitlo_admin.device_allowed((p->>'sensorId')::uuid) then return '{"http":403,"code":"sensor_temporarily_blocked"}';end if;
 return svitlo_sensors.ingest_before_admin(p,proof);
end $$;
alter function svitlo_sensors.ingest(jsonb,text) owner to svitlo_sensor_owner;revoke all on function svitlo_sensors.ingest_before_admin(jsonb,text) from public,svitlo_stage_api,svitlo_stage_worker;revoke all on function svitlo_sensors.ingest(jsonb,text) from public;grant execute on function svitlo_sensors.ingest(jsonb,text) to svitlo_stage_api;
