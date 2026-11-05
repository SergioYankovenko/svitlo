-- Additive throughput/circuit policy. Applied migration 1019 stays immutable.
alter table svitlo_discovery.policy drop constraint policy_interval_seconds_check;
alter table svitlo_discovery.policy drop constraint policy_daily_limit_check;
alter table svitlo_discovery.policy add check(interval_seconds between 5 and 3600), add check(daily_limit between 1 and 50000);
alter table svitlo_discovery.policy
 add column source_interval_seconds integer not null default 10 check(source_interval_seconds between 5 and 3600),
 add column failure_threshold integer not null default 3 check(failure_threshold between 1 and 20),
 add column cooldown_seconds integer not null default 900 check(cooldown_seconds between 60 and 86400),
 add column max_cooldown_seconds integer not null default 21600 check(max_cooldown_seconds between 900 and 604800),
 add check(max_cooldown_seconds>=cooldown_seconds);
update svitlo_discovery.policy set interval_seconds=5,daily_limit=12000 where id;
alter table svitlo_discovery.operator_turn
 add column consecutive_failures integer not null default 0 check(consecutive_failures between 0 and 1000000),
 add column cooldown_level integer not null default 0 check(cooldown_level between 0 and 8),
 add column cooldown_until timestamptz not null default '-infinity',
 add column last_error text check(last_error in ('forbidden','rate_limited','source_unavailable','invalid_source')),
 add column last_failure_at timestamptz,
 add column last_success_at timestamptz;
-- Read only the transport deadlines, not transport tickets or request payloads.
grant usage on schema public,svitlo_regions to svitlo_discovery_owner;
grant select(host,next_start,cooldown_until) on public.svitlo_provider_hosts to svitlo_discovery_owner;
create policy discovery_transport_deadline on public.svitlo_provider_hosts for select to svitlo_discovery_owner using(host='cabinet.cherkasyoblenergo.com');
grant select(operator,next_at,lease_until,cooldown_until) on svitlo_regions.provider_state to svitlo_discovery_owner;
create policy discovery_transport_deadline on svitlo_regions.provider_state for select to svitlo_discovery_owner using(operator in ('ua-kyiv-dtek','ua-kyiv-region-dtek'));
create function svitlo_discovery.source_available_at(op text) returns timestamptz language sql stable security definer set search_path='' as $$
 select case when op='ua-cherkasy' then coalesce((select to_timestamp(greatest(h.next_start,h.cooldown_until)/1000.0) from public.svitlo_provider_hosts h where h.host='cabinet.cherkasyoblenergo.com'),'-infinity'::timestamptz)
 when op in ('ua-kyiv-dtek','ua-kyiv-region-dtek') then coalesce((select to_timestamp(greatest(p.next_at,p.lease_until,p.cooldown_until)/1000.0) from svitlo_regions.provider_state p where p.operator=op),'-infinity'::timestamptz)
 else '-infinity'::timestamptz end
$$;
alter function svitlo_discovery.source_available_at(text) owner to svitlo_discovery_owner;
revoke all on function svitlo_discovery.source_available_at(text) from public,svitlo_stage_api,svitlo_stage_worker;

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
 where task.next_at<=stamp and task.lease_until<=stamp and r.active
 order by case when first_pass then case when task.completed_at is null or task.checkpoint<>'{}'::jsonb then 0 else 1 end else case when task.completed_at is not null and task.checkpoint='{}'::jsonb then 0 else 1 end end,
 turn.last_claimed_at,case when task.cluster_code=turn.active_cluster_code then 0 else 1 end,
 case when task.cluster_code is distinct from turn.active_cluster_code then -task.priority else 0 end,
 concat_ws('/',cluster.region_code,cluster.district_code,cluster.community_code,cluster.code),
 case when task.kind='city' then 0 else 1 end,task.priority desc,task.next_at,task.source_name collate "C",task.id limit 1 for update of task skip locked;
 if not found then
  with deadlines as materialized(select t.operator_id,greatest(t.cooldown_until,svitlo_discovery.source_available_at(t.operator_id),t.last_claimed_at+make_interval(secs=>p.source_interval_seconds)) available_at from svitlo_discovery.operator_turn t)
  select min(greatest(q.next_at,q.lease_until,t.available_at)) into wake from svitlo_discovery.jobs q join svitlo_geo.routes r on r.id=q.route_id join deadlines t on t.operator_id=r.operator_id where r.active;
  return jsonb_build_object('state',case when wake is null then 'idle' else 'sources_waiting' end,'waitMs',case when wake is null then 30000 else greatest(250,least(30000,ceil(extract(epoch from(wake-stamp))*1000)))::integer end);
 end if;
 update svitlo_discovery.jobs set token=proof,lease_until=stamp+interval '90 seconds',attempts=attempts+1,started_at=coalesce(started_at,stamp),last_attempt_at=stamp where id=j.id;
 update svitlo_discovery.operator_turn set last_claimed_at=stamp,active_cluster_code=j.cluster_code where operator_id=(select operator_id from svitlo_geo.routes where id=j.route_id);
 update svitlo_discovery.state set day_key=today,last_claim_at=stamp,daily_claims=case when day_key=today then daily_claims+1 else 1 end where id;
 return jsonb_build_object('state','claimed','id',j.id,'token',proof,'routeId',j.route_id,'kind',j.kind,'sourceKey',j.source_key,'sourceName',j.source_name,'priority',j.priority,'checkpoint',j.checkpoint,'clusterCode',j.cluster_code,'clusterLevel',(select level from svitlo_geo.places where code=j.cluster_code),'settlementCode',j.settlement_code,'scopeStatus',j.scope_status);
end $$;
create or replace function svitlo_discovery.finish(job uuid,proof uuid,packet jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare j svitlo_discovery.jobs;x jsonb;success boolean;next_checkpoint jsonb;retry integer;p svitlo_discovery.policy;t svitlo_discovery.operator_turn;op text;stamp timestamptz;observed boolean;begin
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
 select * into p from svitlo_discovery.policy where id;stamp:=clock_timestamp();
 retry:=case when packet?'error' then greatest(120,least(604800,coalesce((packet->>'retrySeconds')::integer,900))) else 0 end;success:=not(packet?'error');
 if packet?'error' and packet->>'error' not in ('forbidden','rate_limited','source_unavailable','invalid_source') then raise exception 'invalid discovery error';end if;
 update svitlo_discovery.jobs set token=null,lease_until='-infinity',checkpoint=next_checkpoint,next_at=clock_timestamp()+make_interval(secs=>case when (packet->>'complete')::boolean then 604800 else retry end),completed_at=case when (packet->>'complete')::boolean then clock_timestamp() else completed_at end,last_error=packet->>'error' where id=j.id;
 select operator_id into op from svitlo_geo.routes where id=j.route_id;
 select * into t from svitlo_discovery.operator_turn where operator_id=op for update;
 observed:=exists(select 1 from jsonb_array_elements(packet->'events') e where e->>'basis' in ('provider_dictionary','provider_address') and e->>'outcome'<>'source_stale');
 if not success then
  update svitlo_discovery.operator_turn set consecutive_failures=least(1000000,t.consecutive_failures+1),last_error=packet->>'error',last_failure_at=stamp,
   cooldown_level=case when t.consecutive_failures+1>=p.failure_threshold then least(8,t.cooldown_level+1) else t.cooldown_level end,
   cooldown_until=case when t.consecutive_failures+1>=p.failure_threshold then greatest(t.cooldown_until,stamp+make_interval(secs=>least(p.max_cooldown_seconds,p.cooldown_seconds*power(2,t.cooldown_level)::integer))) else t.cooldown_until end where operator_id=op;
 elsif observed then
  update svitlo_discovery.operator_turn set consecutive_failures=0,cooldown_level=0,cooldown_until='-infinity',last_error=null,last_success_at=stamp where operator_id=op;
 end if;
 update svitlo_discovery.state set last_success_at=case when success then clock_timestamp() else last_success_at end,last_error=packet->>'error' where id;
 delete from svitlo_discovery.events where id in(select e.id from svitlo_discovery.events e where e.last_seen_at<clock_timestamp()-make_interval(days=>(select retention_days from svitlo_discovery.policy where id)) order by last_seen_at limit 1000);
 return true;
end $$;

alter function svitlo_discovery.claim() owner to svitlo_discovery_owner;
alter function svitlo_discovery.finish(uuid,uuid,jsonb) owner to svitlo_discovery_owner;
revoke all on function svitlo_discovery.claim(),svitlo_discovery.finish(uuid,uuid,jsonb) from public;
grant execute on function svitlo_discovery.claim(),svitlo_discovery.finish(uuid,uuid,jsonb) to svitlo_stage_worker;
