-- ARCH-MOD-01-03. Versioned module outbox; legacy catalogue/producer queues stay compatible.
create table svitlo_events.event_types(
 type text primary key, schema_version integer not null default 1 check(schema_version between 1 and 32),
 payload_keys text[] not null
);
insert into svitlo_events.event_types(type,payload_keys) values
 ('billing.reconcile.v1',array['purchaseId']),
 ('entitlement.changed.v1',array['accountId','entitlementRevision']),
 ('notification.intent.v1',array['intentId']),
 ('charging.refresh.v1',array['stationId']);
create table svitlo_events.consumers(
 id text primary key,type text not null references svitlo_events.event_types(type),
 max_attempts integer not null default 5 check(max_attempts between 1 and 10),
 lease_seconds integer not null default 60 check(lease_seconds between 15 and 120)
);
insert into svitlo_events.consumers(id,type) values
 ('billing-reconcile-v1','billing.reconcile.v1'),('entitlement-project-v1','entitlement.changed.v1'),
 ('notification-delivery-v1','notification.intent.v1'),('charging-refresh-v1','charging.refresh.v1');
create table svitlo_events.domain_events(
 id uuid primary key default gen_random_uuid(),type text not null references svitlo_events.event_types(type),
 aggregate_id text not null check(length(aggregate_id) between 1 and 200),
 revision bigint not null check(revision between 1 and 9007199254740991),schema_version integer not null check(schema_version between 1 and 32),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=8192),
 created_at timestamptz not null default clock_timestamp(),deadline timestamptz not null,
 unique(type,aggregate_id,revision)
);
create table svitlo_events.deliveries(
 id uuid primary key default gen_random_uuid(),event_id uuid not null references svitlo_events.domain_events(id),
 consumer text not null references svitlo_events.consumers(id),state text not null default 'ready' check(state in ('ready','running','done','dead')),
 attempts integer not null default 0 check(attempts between 0 and 10),next_at timestamptz not null default clock_timestamp(),
 token uuid,lease_until timestamptz,finished_at timestamptz,error_code text,replays integer not null default 0 check(replays between 0 and 5),
 unique(event_id,consumer)
);
create index domain_deliveries_due on svitlo_events.deliveries(consumer,next_at,id) where state in ('ready','running');
create index domain_deliveries_cleanup on svitlo_events.deliveries(finished_at) where state in ('done','dead');
create index domain_events_cleanup on svitlo_events.domain_events(created_at);
create table svitlo_events.replay_audit(request_id uuid primary key,delivery_id uuid not null,actor uuid not null,reason text not null check(length(reason) between 8 and 500),at timestamptz not null default clock_timestamp());
do $$ declare t text;begin
 foreach t in array array['event_types','consumers','domain_events','deliveries','replay_audit'] loop
  execute 'alter table svitlo_events.'||t||' owner to svitlo_events_owner';
  execute 'revoke all on svitlo_events.'||t||' from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session';
 end loop;
end $$;

create function svitlo_events.publish(event_type text,aggregate_key text,aggregate_revision bigint,data jsonb,due_deadline timestamptz default clock_timestamp()+interval '1 day',version integer default 1) returns uuid
language plpgsql security definer set search_path='' as $$
declare spec svitlo_events.event_types;e svitlo_events.domain_events;result uuid;begin
 select * into spec from svitlo_events.event_types where type=event_type;
 if not found or version is distinct from spec.schema_version or aggregate_key is null or length(aggregate_key) not between 1 and 200
  or aggregate_revision is null or aggregate_revision not between 1 and 9007199254740991
  or data is null or jsonb_typeof(data)<>'object' or octet_length(data::text)>8192
  or not array(select jsonb_object_keys(data))<@spec.payload_keys
  or not spec.payload_keys<@array(select jsonb_object_keys(data))
  or due_deadline is null or due_deadline<=clock_timestamp() or due_deadline>clock_timestamp()+interval '30 days' then raise exception 'invalid domain event';end if;
 if not exists(select 1 from svitlo_events.consumers where type=event_type) then raise exception 'event has no consumer';end if;
 insert into svitlo_events.domain_events(type,aggregate_id,revision,schema_version,payload,deadline)
 values(event_type,aggregate_key,aggregate_revision,version,data,due_deadline) on conflict(type,aggregate_id,revision) do nothing returning id into result;
 if result is null then
  select * into e from svitlo_events.domain_events where type=event_type and aggregate_id=aggregate_key and revision=aggregate_revision;
  if e.schema_version is distinct from version or e.payload is distinct from data then raise exception 'domain revision conflict';end if;
  return e.id;
 end if;
 insert into svitlo_events.deliveries(event_id,consumer) select result,id from svitlo_events.consumers where type=event_type;
 return result;
end $$;

create function svitlo_events.claim_delivery(consumer_key text,batch_size integer default 10,supported_version integer default 1) returns jsonb
language plpgsql security definer set search_path='' as $$
declare spec svitlo_events.consumers;result jsonb;begin
 select * into spec from svitlo_events.consumers where id=consumer_key;
 if not found or batch_size is null or batch_size not between 1 and 20 or supported_version is null or supported_version not between 1 and 32 then raise exception 'invalid consumer claim';end if;
 update svitlo_events.deliveries d set state='dead',finished_at=clock_timestamp(),token=null,lease_until=null,
  error_code=case when e.deadline<=clock_timestamp() then 'deadline_expired' else 'lease_expired' end
 from svitlo_events.domain_events e where e.id=d.event_id and d.id in(
  select x.id from svitlo_events.deliveries x join svitlo_events.domain_events y on y.id=x.event_id
  where x.consumer=consumer_key and x.state in ('ready','running') and
   (y.deadline<=clock_timestamp() or x.state='running' and x.lease_until<=clock_timestamp() and x.attempts>=spec.max_attempts)
  limit 20 for update of x skip locked);
 with due as(
  select d.id from svitlo_events.deliveries d join svitlo_events.domain_events e on e.id=d.event_id
  where d.consumer=consumer_key and d.attempts<spec.max_attempts and d.next_at<=clock_timestamp()
   and e.schema_version=supported_version and e.deadline>clock_timestamp()
   and (d.state='ready' or d.state='running' and d.lease_until<=clock_timestamp())
  order by d.next_at,d.id limit batch_size for update of d skip locked
 ),claimed as(
  update svitlo_events.deliveries d set state='running',attempts=d.attempts+1,token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>spec.lease_seconds)
  from due where d.id=due.id returning d.*
 ) select coalesce(jsonb_agg(jsonb_build_object('deliveryId',d.id,'eventId',e.id,'consumer',d.consumer,'token',d.token,
  'attempt',d.attempts,'aggregateId',e.aggregate_id,'revision',e.revision,'schemaVersion',e.schema_version,'payload',e.payload,'deadline',e.deadline)),'[]'::jsonb)
 into result from claimed d join svitlo_events.domain_events e on e.id=d.event_id;
 return result;
end $$;

create function svitlo_events.lock_delivery(delivery_id uuid,proof uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare d svitlo_events.deliveries;begin
 select * into d from svitlo_events.deliveries where id=delivery_id and token=proof and state='running' for update;
 return found and d.lease_until>clock_timestamp() and exists(select 1 from svitlo_events.domain_events where id=d.event_id and deadline>clock_timestamp());
end $$;
create function svitlo_events.finish_delivery(delivery_id uuid,proof uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not svitlo_events.lock_delivery(delivery_id,proof) then return false;end if;
 update svitlo_events.deliveries set state='done',finished_at=clock_timestamp(),token=null,lease_until=null,error_code=null where id=delivery_id;
 return true;
end $$;
create function svitlo_events.fail_delivery(delivery_id uuid,proof uuid,reason text) returns boolean
language plpgsql security definer set search_path='' as $$
declare d svitlo_events.deliveries;spec svitlo_events.consumers;deadline timestamptz;retry_at timestamptz;begin
 select * into d from svitlo_events.deliveries where id=delivery_id and token=proof and state='running' for update;
 if not found or d.lease_until<=clock_timestamp() then return false;end if;
 select * into spec from svitlo_events.consumers where id=d.consumer;
 select e.deadline into deadline from svitlo_events.domain_events e where e.id=d.event_id;
 retry_at:=clock_timestamp()+make_interval(secs=>least(900,5*(2^(d.attempts-1))::integer)*(.75+random()*.5));
 update svitlo_events.deliveries set state=case when d.attempts>=spec.max_attempts or retry_at>=deadline then 'dead' else 'ready' end,
  next_at=retry_at,finished_at=case when d.attempts>=spec.max_attempts or retry_at>=deadline then clock_timestamp() end,
  token=null,lease_until=null,error_code=case when reason in ('dependency_unavailable','invalid_payload','handler_error','revision_changed') then reason else 'handler_error' end where id=d.id;
 return true;
end $$;

create function svitlo_events.replay_delivery(delivery_id uuid,actor_id uuid,request_id uuid,why text) returns boolean
language plpgsql security definer set search_path='' as $$
declare prior svitlo_events.replay_audit;d svitlo_events.deliveries;begin
 if actor_id is null or request_id is null or why is null or length(why) not between 8 and 500 then raise exception 'replay reason required';end if;
 perform pg_advisory_xact_lock(hashtextextended('domain-replay:'||request_id::text,0));
 select * into prior from svitlo_events.replay_audit where replay_audit.request_id=replay_delivery.request_id;
 if found then
  if prior.delivery_id<>delivery_id or prior.actor<>actor_id or prior.reason<>why then raise exception 'replay identity conflict';end if;return true;
 end if;
 select * into d from svitlo_events.deliveries where id=delivery_id for update;
 if not found or d.state<>'dead' or d.replays>=5 or not exists(select 1 from svitlo_events.domain_events where id=d.event_id and deadline>clock_timestamp()) then return false;end if;
 insert into svitlo_events.replay_audit values(request_id,delivery_id,actor_id,why,clock_timestamp());
 update svitlo_events.deliveries set state='ready',attempts=0,replays=replays+1,next_at=clock_timestamp(),finished_at=null,error_code=null,token=null,lease_until=null where id=d.id;
 return true;
end $$;
create function svitlo_events.domain_cleanup() returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;begin
 delete from svitlo_events.deliveries where id in(select id from svitlo_events.deliveries where state in ('done','dead') and finished_at<clock_timestamp()-interval '91 days' order by finished_at limit 1000 for update skip locked);
 get diagnostics n=row_count;
 delete from svitlo_events.domain_events where id in(select e.id from svitlo_events.domain_events e where e.created_at<clock_timestamp()-interval '91 days' and not exists(select 1 from svitlo_events.deliveries d where d.event_id=e.id) order by e.created_at limit 1000);
 return n;
end $$;
do $$ declare f text;begin
 foreach f in array array['publish(text,text,bigint,jsonb,timestamptz,integer)','claim_delivery(text,integer,integer)','lock_delivery(uuid,uuid)','finish_delivery(uuid,uuid)','fail_delivery(uuid,uuid,text)','replay_delivery(uuid,uuid,uuid,text)','domain_cleanup()'] loop
  execute 'alter function svitlo_events.'||f||' owner to svitlo_events_owner';
  execute 'revoke all on function svitlo_events.'||f||' from public';
 end loop;
 foreach f in array array['claim_delivery(text,integer,integer)','lock_delivery(uuid,uuid)','finish_delivery(uuid,uuid)','fail_delivery(uuid,uuid,text)','domain_cleanup()'] loop
  execute 'grant execute on function svitlo_events.'||f||' to svitlo_stage_worker';
 end loop;
end $$;
-- publish/replay are granted only to their module owners/admin command facade
-- by subsequent migrations. API and worker cannot forge purchases or replay work.
