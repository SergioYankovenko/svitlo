-- GEO-02 / GEO-AUD-01. Additive test-server discovery; no profile migration or catalogue repair.
-- Take final DDL locks before ACL/catalog writes. Auto-analyze must not hold a
-- table while waiting on our ACL XID when CREATE POLICY needs the same table.
-- Fixed order, short transaction; diagnostic seeding happens after commit.
lock table svitlo_geo.places,svitlo_geo.routes,svitlo_geo.route_places,
 svitlo_vps.catalog,svitlo_vps.catalog_aliases,svitlo_vps.catalog_exclusions,svitlo_vps.operators in access exclusive mode;
do $$ begin if not exists(select 1 from pg_roles where rolname='svitlo_discovery_owner') then create role svitlo_discovery_owner nologin nobypassrls;end if;end $$;
create schema svitlo_discovery authorization svitlo_discovery_owner;
revoke all on schema svitlo_discovery from public;
grant usage on schema svitlo_discovery to svitlo_stage_api,svitlo_stage_worker;
grant usage on schema svitlo_geo,svitlo_vps to svitlo_discovery_owner;
grant select on svitlo_geo.routes,svitlo_geo.route_places,svitlo_geo.places,svitlo_vps.catalog,svitlo_vps.catalog_aliases,svitlo_vps.operators to svitlo_discovery_owner;
create policy discovery_reference_read on svitlo_geo.routes for select to svitlo_discovery_owner using(true);
create policy discovery_reference_read on svitlo_geo.route_places for select to svitlo_discovery_owner using(true);
create policy discovery_reference_read on svitlo_geo.places for select to svitlo_discovery_owner using(true);
-- This allocator can add verified on-demand entries, but cannot update/delete existing ones.
grant insert on svitlo_vps.catalog,svitlo_vps.catalog_aliases to svitlo_discovery_owner;
-- Existing invoker trigger catalog_classify runs on every new catalogue row.
-- Its exact-label quarantine needs these privileges for the newly allocated ID.
-- This role cannot log in/be assumed and the sole API allocator never updates
-- an existing row; the collector cannot execute it.
grant select,insert,update,delete on svitlo_vps.catalog_exclusions to svitlo_discovery_owner;
grant execute on function svitlo_vps.catalog_service_label(text,text) to svitlo_discovery_owner;
grant execute on function svitlo_vps.catalog_upsert(text,text,text,text,uuid,jsonb,jsonb) to svitlo_discovery_owner;
create table svitlo_discovery.policy(id boolean primary key default true check(id),enabled boolean not null default true,interval_seconds integer not null default 120 check(interval_seconds>=120),daily_limit integer not null default 360 check(daily_limit between 1 and 360),retention_days integer not null default 90 check(retention_days between 7 and 90));
insert into svitlo_discovery.policy(id) values(true);
create table svitlo_discovery.state(id boolean primary key default true check(id),day_key date,last_claim_at timestamptz,daily_claims integer not null default 0,last_success_at timestamptz,last_error text);
insert into svitlo_discovery.state(id) values(true);
create table svitlo_discovery.operator_turn(operator_id text primary key references svitlo_vps.operators(id),last_claimed_at timestamptz not null default '-infinity',active_cluster_code text references svitlo_geo.places(code));
insert into svitlo_discovery.operator_turn(operator_id) values('ua-cherkasy'),('ua-kyiv-dtek'),('ua-kyiv-region-dtek');
create table svitlo_discovery.jobs(
 id uuid primary key default gen_random_uuid(),route_id text not null references svitlo_geo.routes(id),cluster_code text not null references svitlo_geo.places(code),settlement_code text references svitlo_geo.places(code),scope_status text not null check(scope_status in ('one_settlement','ambiguous_in_community','ambiguous_in_district','ambiguous_in_region','unmatched')),kind text not null check(kind in ('city','street')),source_key text not null default '' check(length(source_key)<=240),source_name text not null check(length(source_name)<=240),
 priority integer not null default 0,checkpoint jsonb not null default '{}',next_at timestamptz not null default now(),lease_until timestamptz not null default '-infinity',token uuid,attempts integer not null default 0,started_at timestamptz,last_attempt_at timestamptz,completed_at timestamptz,last_error text,unique(route_id,kind,source_key));
create index discovery_due on svitlo_discovery.jobs(priority desc,next_at,id);
create index discovery_due_time on svitlo_discovery.jobs(next_at,lease_until,route_id);
create index discovery_cluster_progress on svitlo_discovery.jobs(cluster_code,kind,completed_at);
create index discovery_settlement_progress on svitlo_discovery.jobs(settlement_code) where settlement_code is not null;
create table svitlo_discovery.events(
 id uuid primary key default gen_random_uuid(),day_key date not null default (now() at time zone 'Europe/Kyiv')::date,
 route_id text not null references svitlo_geo.routes(id),cluster_code text not null references svitlo_geo.places(code),settlement_code text references svitlo_geo.places(code),subject_key text not null check(length(subject_key)<=600),kind text not null check(kind in ('city','street','house')),
 street_key text check(length(street_key)<=240),street_name text check(length(street_name)<=240),house text check(length(house)<=120),
 outcome text not null check(outcome in ('streets_listed','streets_empty','street_absent','houses_listed','houses_empty','house_absent','queue_confirmed','queue_estimated','queue_partial','queue_missing','queue_ambiguous','queue_not_in_schedule','queue_unchecked','provider_external','upstream_forbidden','upstream_rate_limited','upstream_unavailable','invalid_source','route_unmatched','source_stale')),
 basis text not null check(basis in ('provider_dictionary','provider_address','service_registry','transport','katottg_mapping')),
 source_checked_at timestamptz,detail jsonb not null default '{}',first_seen_at timestamptz not null default now(),last_seen_at timestamptz not null default now(),observations integer not null default 1,
 unique(day_key,route_id,cluster_code,subject_key,outcome));
create index discovery_events_recent on svitlo_discovery.events(last_seen_at desc);
create index discovery_events_route on svitlo_discovery.events(route_id,outcome,last_seen_at desc);
create index discovery_events_cluster on svitlo_discovery.events(cluster_code,kind,outcome);
create function svitlo_discovery.route_scope(rid text) returns table(cluster_code text,settlement_code text,scope_status text) language sql stable set search_path='' as $$
 with members as(select p.* from svitlo_geo.route_places l join svitlo_geo.places p on p.code=l.settlement_code where l.route_id=rid and p.active),
 stats as(select count(*) n,min(code) settlement,min(community_code) community,min(district_code) district,count(community_code) communities,count(distinct community_code) distinct_communities,count(district_code) districts,count(distinct district_code) distinct_districts from members)
 select case when s.n=1 then coalesce(s.community,s.district,r.region_code) when s.n>1 and s.communities=s.n and s.distinct_communities=1 then s.community when s.n>1 and s.districts=s.n and s.distinct_districts=1 then s.district else r.region_code end,
 case when s.n=1 then s.settlement end,
 case when s.n=0 then 'unmatched' when s.n=1 then 'one_settlement' when s.communities=s.n and s.distinct_communities=1 then 'ambiguous_in_community' when s.districts=s.n and s.distinct_districts=1 then 'ambiguous_in_district' else 'ambiguous_in_region' end
 from svitlo_geo.routes r cross join stats s where r.id=rid;
$$;
alter function svitlo_discovery.route_scope(text) owner to svitlo_discovery_owner;
revoke all on function svitlo_discovery.route_scope(text) from public;
do $$ begin execute format('grant execute on function svitlo_discovery.route_scope(text) to %I',current_user);end $$;

create function svitlo_discovery.catalog_entry(rid text,settlement text,entity_kind text,parent uuid,source_key text,display_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare r svitlo_geo.routes;c uuid;found_id uuid;key text;ref jsonb;street svitlo_vps.catalog;hop integer:=0;begin
 select x.* into r from svitlo_geo.routes x where x.id=rid and x.active and exists(select 1 from svitlo_geo.route_places l where l.route_id=x.id and l.settlement_code=settlement);
 if not found or r.operator_id<>'ua-cherkasy' then raise exception 'invalid discovery route';end if;
 if entity_kind not in ('city','street','address') or source_key is null or display_name is null or length(display_name) not between 1 and 240 or display_name ~ '[[:cntrl:]]' then raise exception 'invalid discovery entry';end if;
 if entity_kind='street' and source_key !~ '^[A-Za-z0-9_-]{1,100}$' or entity_kind='address' and (length(source_key) not between 1 and 120 or source_key ~ '[[:cntrl:]]') then raise exception 'invalid discovery source key';end if;
 perform pg_advisory_xact_lock(311032028);
 select entity_id into c from svitlo_vps.catalog_aliases where operator_id=r.operator_id and kind='city' and provider_key=jsonb_build_array(r.branch_id,r.provider_city_id)::text;
 c:=coalesce(c,r.legacy_catalog_city_id);
 if c is null then c:=svitlo_vps.catalog_upsert(r.operator_id,'city',jsonb_build_array(r.branch_id,r.provider_city_id)::text,r.provider_city_name,null,jsonb_build_object('department',r.branch_id,'cityId',r.provider_city_id),jsonb_build_object('origin','geo_on_demand','sourceURL',r.source_url));end if;
 loop exit when not exists(select 1 from svitlo_vps.catalog where id=c and redirect_to is not null);select redirect_to into c from svitlo_vps.catalog where id=c;hop:=hop+1;if hop>8 then raise exception 'invalid discovery alias';end if;end loop;
 if entity_kind='city' then return c;end if;
 if entity_kind='street' then
  if parent is distinct from c then raise exception 'foreign discovery parent';end if;
  key:=jsonb_build_array(r.branch_id,r.provider_city_id,source_key)::text;
  ref:=jsonb_build_object('department',r.branch_id,'cityId',r.provider_city_id,'streetId',source_key,'city',r.provider_city_name,'street',display_name);
 else
  select e.* into street from svitlo_vps.catalog e where e.id=parent and e.kind='street' and e.parent_id=c;
  if not found then raise exception 'foreign discovery parent';end if;
  select a.provider_key into key from svitlo_vps.catalog_aliases a where a.operator_id=r.operator_id and a.kind='street' and a.entity_id=parent and (a.provider_key::jsonb)->>0=r.branch_id and (a.provider_key::jsonb)->>1=r.provider_city_id limit 1;
  if key is null then raise exception 'foreign discovery street';end if;
  ref:=jsonb_build_object('department',r.branch_id,'cityId',r.provider_city_id,'streetId',(key::jsonb)->>2,'city',r.provider_city_name,'street',street.label,'house',source_key);
  key:=jsonb_build_array(r.branch_id,r.provider_city_id,(key::jsonb)->>2,source_key)::text;
 end if;
 select entity_id into found_id from svitlo_vps.catalog_aliases where operator_id=r.operator_id and kind=entity_kind and provider_key=key;
 if found_id is not null then return found_id;end if;
 return svitlo_vps.catalog_upsert(r.operator_id,entity_kind,key,display_name,parent,ref,jsonb_build_object('origin','geo_on_demand','sourceURL',r.source_url));
end $$;
alter function svitlo_discovery.catalog_entry(text,text,text,uuid,text,text) owner to svitlo_discovery_owner;
revoke all on function svitlo_discovery.catalog_entry(text,text,text,uuid,text,text) from public;
grant execute on function svitlo_discovery.catalog_entry(text,text,text,uuid,text,text) to svitlo_stage_api;

create function svitlo_discovery.claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare p svitlo_discovery.policy;s svitlo_discovery.state;j svitlo_discovery.jobs;stamp timestamptz:=clock_timestamp();today date:=(stamp at time zone 'Europe/Kyiv')::date;proof uuid:=gen_random_uuid();begin
 select * into p from svitlo_discovery.policy where id;if not p.enabled then return '{"state":"disabled"}';end if;
 select * into s from svitlo_discovery.state where id for update;
 if s.last_claim_at>stamp-make_interval(secs=>p.interval_seconds) then return '{"state":"not_due"}';end if;
 if s.day_key=today and s.daily_claims>=p.daily_limit then return '{"state":"daily_limit"}';end if;
 if exists(select 1 from svitlo_discovery.jobs where lease_until>stamp) then return '{"state":"busy"}';end if;
 select task.* into j from svitlo_discovery.jobs task join svitlo_geo.routes r on r.id=task.route_id join svitlo_geo.places cluster on cluster.code=task.cluster_code join svitlo_discovery.operator_turn turn on turn.operator_id=r.operator_id where task.next_at<=stamp and task.lease_until<=stamp
 order by turn.last_claimed_at,case when task.cluster_code=turn.active_cluster_code then 0 else 1 end,
 case when task.cluster_code is distinct from turn.active_cluster_code then -task.priority else 0 end,
 concat_ws('/',cluster.region_code,cluster.district_code,cluster.community_code,cluster.code),
 case when task.kind='city' then 0 else 1 end,case when task.completed_at is null then 0 else 1 end,task.priority desc,task.next_at,task.source_name collate "C",task.id limit 1 for update of task skip locked;
 if not found then return '{"state":"idle"}';end if;
 update svitlo_discovery.jobs set token=proof,lease_until=stamp+interval '90 seconds',attempts=attempts+1,started_at=coalesce(started_at,stamp),last_attempt_at=stamp where id=j.id;
 update svitlo_discovery.operator_turn set last_claimed_at=stamp,active_cluster_code=j.cluster_code where operator_id=(select operator_id from svitlo_geo.routes where id=j.route_id);
 update svitlo_discovery.state set day_key=today,last_claim_at=stamp,daily_claims=case when day_key=today then daily_claims+1 else 1 end where id;
 return jsonb_build_object('state','claimed','id',j.id,'token',proof,'routeId',j.route_id,'kind',j.kind,'sourceKey',j.source_key,'sourceName',j.source_name,'priority',j.priority,'checkpoint',j.checkpoint,'clusterCode',j.cluster_code,'clusterLevel',(select level from svitlo_geo.places where code=j.cluster_code),'settlementCode',j.settlement_code,'scopeStatus',j.scope_status);
end $$;
create function svitlo_discovery.finish(job uuid,proof uuid,packet jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare j svitlo_discovery.jobs;x jsonb;success boolean;next_checkpoint jsonb;retry integer;begin
 select * into j from svitlo_discovery.jobs where id=job and token=proof and lease_until>clock_timestamp() for update;if not found then return false;end if;
 if jsonb_typeof(packet) is distinct from 'object' or pg_column_size(packet)>2000000 or exists(select 1 from jsonb_object_keys(packet) k where k not in ('events','children','checkpoint','complete','retrySeconds','error')) or jsonb_typeof(packet->'events') is distinct from 'array' or jsonb_array_length(packet->'events')>250 or jsonb_typeof(packet->'children') is distinct from 'array' or jsonb_array_length(packet->'children')>5000 then raise exception 'invalid discovery completion';end if;
 for x in select value from jsonb_array_elements(packet->'events') loop
  if jsonb_typeof(x) is distinct from 'object' or exists(select 1 from jsonb_object_keys(x) k where k not in ('subjectKey','kind','streetKey','streetName','house','outcome','basis','sourceCheckedAt','detail')) or coalesce(x->>'subjectKey','')='' or jsonb_typeof(coalesce(x->'detail','{}'))<>'object' or pg_column_size(coalesce(x->'detail','{}'))>3000 or exists(select 1 from jsonb_object_keys(coalesce(x->'detail','{}')) k where k not in ('count','localCount','groups','sourceState','fresh','mappingState','resolutionState','complete','registryVersion','estimated','reviewedAt')) then raise exception 'invalid discovery observation';end if;
  insert into svitlo_discovery.events(route_id,cluster_code,settlement_code,subject_key,kind,street_key,street_name,house,outcome,basis,source_checked_at,detail)
   values(j.route_id,j.cluster_code,j.settlement_code,x->>'subjectKey',x->>'kind',x->>'streetKey',x->>'streetName',x->>'house',x->>'outcome',x->>'basis',(x->>'sourceCheckedAt')::timestamptz,coalesce(x->'detail','{}'))
   on conflict(day_key,route_id,cluster_code,subject_key,outcome) do update set last_seen_at=clock_timestamp(),observations=svitlo_discovery.events.observations+1,source_checked_at=excluded.source_checked_at,detail=excluded.detail;
 end loop;
 for x in select value from jsonb_array_elements(packet->'children') loop
  if exists(select 1 from jsonb_object_keys(x) k where k not in ('key','name')) or coalesce(x->>'key','')='' or coalesce(x->>'name','')='' then raise exception 'invalid discovery child';end if;
  insert into svitlo_discovery.jobs(route_id,cluster_code,settlement_code,scope_status,kind,source_key,source_name,priority) values(j.route_id,j.cluster_code,j.settlement_code,j.scope_status,'street',x->>'key',x->>'name',j.priority-1) on conflict(route_id,kind,source_key) do nothing;
 end loop;
 next_checkpoint:=coalesce(packet->'checkpoint','{}');if jsonb_typeof(next_checkpoint)<>'object' or exists(select 1 from jsonb_object_keys(next_checkpoint) k where k not in ('offset','digest')) or pg_column_size(next_checkpoint)>300 then raise exception 'invalid discovery checkpoint';end if;
 retry:=greatest(120,least(604800,coalesce((packet->>'retrySeconds')::integer,120)));success:=not(packet?'error');
 if packet?'error' and packet->>'error' not in ('forbidden','rate_limited','source_unavailable','invalid_source') then raise exception 'invalid discovery error';end if;
 update svitlo_discovery.jobs set token=null,lease_until='-infinity',checkpoint=next_checkpoint,next_at=clock_timestamp()+make_interval(secs=>case when (packet->>'complete')::boolean then 604800 else retry end),completed_at=case when (packet->>'complete')::boolean then clock_timestamp() else completed_at end,last_error=packet->>'error' where id=j.id;
 update svitlo_discovery.state set last_success_at=case when success then clock_timestamp() else last_success_at end,last_error=packet->>'error' where id;
 delete from svitlo_discovery.events where id in(select e.id from svitlo_discovery.events e where e.last_seen_at<clock_timestamp()-make_interval(days=>(select retention_days from svitlo_discovery.policy where id)) order by last_seen_at limit 1000);
 return true;
end $$;
do $$ declare t text;begin
 foreach t in array array['policy','state','operator_turn','jobs','events'] loop
  execute format('alter table svitlo_discovery.%I owner to svitlo_discovery_owner',t);
  execute format('alter table svitlo_discovery.%I enable row level security',t);
  execute format('revoke all on svitlo_discovery.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);
 end loop;
end $$;
alter function svitlo_discovery.claim() owner to svitlo_discovery_owner;
alter function svitlo_discovery.finish(uuid,uuid,jsonb) owner to svitlo_discovery_owner;
revoke all on function svitlo_discovery.claim(),svitlo_discovery.finish(uuid,uuid,jsonb) from public;
grant execute on function svitlo_discovery.claim(),svitlo_discovery.finish(uuid,uuid,jsonb) to svitlo_stage_worker;
