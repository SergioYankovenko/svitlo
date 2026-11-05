-- Official administrative status is an independent, expiring collection mask.
-- Never modifies jobs, checkpoints, addresses, sensor bindings or private profiles.
create table svitlo_discovery.territory_editions(hash text primary key check(hash ~ '^[a-f0-9]{64}$'),source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),first_checked_at timestamptz not null,last_checked_at timestamptz not null,metadata jsonb not null check(jsonb_typeof(metadata)='object' and pg_column_size(metadata)<10000));
create table svitlo_discovery.territory_current(id boolean primary key default true check(id),edition_hash text not null references svitlo_discovery.territory_editions(hash),checked_at timestamptz not null,expires_at timestamptz not null check(expires_at>checked_at));
create table svitlo_discovery.territory_places(code text primary key references svitlo_geo.places(code),status text not null check(status in ('occupied','liberated','active_combat','possible_combat','ended','unknown','ambiguous','unlisted')),source_code text references svitlo_geo.places(code),effective_from date,source_record_id bigint);
create table svitlo_discovery.territory_routes(route_id text primary key references svitlo_geo.routes(id),held boolean not null,occupied_candidates integer not null check(occupied_candidates>=0),total_candidates integer not null check(total_candidates>=occupied_candidates));
create index discovery_held_routes on svitlo_discovery.territory_routes(route_id) where held;
do $$ declare t text;begin
 foreach t in array array['territory_editions','territory_current','territory_places','territory_routes'] loop
  execute format('alter table svitlo_discovery.%I owner to svitlo_discovery_owner',t);
  execute format('alter table svitlo_discovery.%I enable row level security',t);
  execute format('revoke all on svitlo_discovery.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);
 end loop;
end $$;
create or replace function svitlo_discovery.claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare p svitlo_discovery.policy;s svitlo_discovery.state;j svitlo_discovery.jobs;
 stamp timestamptz:=clock_timestamp();today date:=(stamp at time zone 'Europe/Kyiv')::date;proof uuid:=gen_random_uuid();wake timestamptz;first_pass boolean;
begin
 select * into p from svitlo_discovery.policy where id;if not p.enabled then return '{"state":"disabled","waitMs":30000}';end if;
 select * into s from svitlo_discovery.state where id for update;
 if s.last_claim_at>stamp-make_interval(secs=>p.interval_seconds) then return jsonb_build_object('state','not_due','waitMs',greatest(100,ceil(extract(epoch from(s.last_claim_at+make_interval(secs=>p.interval_seconds)-stamp))*1000)::integer));end if;
 if s.day_key=today and s.daily_claims>=p.daily_limit then return '{"state":"daily_limit","waitMs":30000}';end if;
 if exists(select 1 from svitlo_discovery.jobs where lease_until>stamp) then return '{"state":"busy","waitMs":1000}';end if;
 -- 95% preference for never-completed/resumable work; every twentieth turn may refresh due observations.
 first_pass:=mod(case when s.day_key=today then s.daily_claims else 0 end,20)<>19;
 with ready_sources as materialized (
  select t.* from svitlo_discovery.operator_turn t
  where greatest(t.cooldown_until,svitlo_discovery.source_available_at(t.operator_id),t.last_claimed_at+make_interval(secs=>p.source_interval_seconds))<=stamp
 )
 select task.* into j from svitlo_discovery.jobs task join svitlo_geo.routes r on r.id=task.route_id
 join svitlo_geo.places cluster on cluster.code=task.cluster_code join ready_sources turn on turn.operator_id=r.operator_id
 where task.next_at<=stamp and task.lease_until<=stamp and r.active and not exists(select 1 from svitlo_discovery.territory_routes tr cross join svitlo_discovery.territory_current tc where tr.route_id=task.route_id and tr.held and tc.expires_at>stamp)
 order by case when first_pass then case when task.completed_at is null or task.checkpoint<>'{}'::jsonb then 0 else 1 end else case when task.completed_at is not null and task.checkpoint='{}'::jsonb then 0 else 1 end end,
 turn.last_claimed_at,case when task.cluster_code=turn.active_cluster_code then 0 else 1 end,
 case when task.cluster_code is distinct from turn.active_cluster_code then -task.priority else 0 end,
 concat_ws('/',cluster.region_code,cluster.district_code,cluster.community_code,cluster.code),
 case when task.kind='city' then 0 else 1 end,task.priority desc,task.next_at,task.source_name collate "C",task.id limit 1 for update of task skip locked;
 if not found then
  with deadlines as materialized(select t.operator_id,greatest(t.cooldown_until,svitlo_discovery.source_available_at(t.operator_id),t.last_claimed_at+make_interval(secs=>p.source_interval_seconds)) available_at from svitlo_discovery.operator_turn t)
  select min(greatest(q.next_at,q.lease_until,t.available_at)) into wake from svitlo_discovery.jobs q join svitlo_geo.routes r on r.id=q.route_id join deadlines t on t.operator_id=r.operator_id where r.active and not exists(select 1 from svitlo_discovery.territory_routes tr cross join svitlo_discovery.territory_current tc where tr.route_id=q.route_id and tr.held and tc.expires_at>stamp);
  return jsonb_build_object('state',case when wake is null and exists(select 1 from svitlo_discovery.territory_routes tr cross join svitlo_discovery.territory_current tc where tr.held and tc.expires_at>stamp) then 'territory_hold' when wake is null then 'idle' else 'sources_waiting' end,'waitMs',case when wake is null then 30000 else greatest(250,least(30000,ceil(extract(epoch from(wake-stamp))*1000)))::integer end);
 end if;
 update svitlo_discovery.jobs set token=proof,lease_until=stamp+interval '90 seconds',attempts=attempts+1,started_at=coalesce(started_at,stamp),last_attempt_at=stamp where id=j.id;
 update svitlo_discovery.operator_turn set last_claimed_at=stamp,active_cluster_code=j.cluster_code where operator_id=(select operator_id from svitlo_geo.routes where id=j.route_id);
 update svitlo_discovery.state set day_key=today,last_claim_at=stamp,daily_claims=case when day_key=today then daily_claims+1 else 1 end where id;
 return jsonb_build_object('state','claimed','id',j.id,'token',proof,'routeId',j.route_id,'kind',j.kind,'sourceKey',j.source_key,'sourceName',j.source_name,'priority',j.priority,'checkpoint',j.checkpoint,'clusterCode',j.cluster_code,'clusterLevel',(select level from svitlo_geo.places where code=j.cluster_code),'settlementCode',j.settlement_code,'scopeStatus',j.scope_status);
end $$;
alter function svitlo_discovery.claim() owner to svitlo_discovery_owner;
revoke all on function svitlo_discovery.claim() from public;
grant execute on function svitlo_discovery.claim() to svitlo_stage_worker;
