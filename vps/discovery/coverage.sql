begin isolation level repeatable read read only;
set local statement_timeout='12s';
select jsonb_build_object('kind','places','rows',jsonb_agg(x)) from (
 select p.code,p.parent_code,p.level,p.category,p.name,p.region_code,p.district_code,p.community_code,t.status territory_status
 from svitlo_geo.places p left join svitlo_discovery.territory_places t on t.code=p.code where p.active and p.level<=4 order by p.level,p.code
) x;
select jsonb_build_object('kind','configured','rows',jsonb_agg(x)) from (
 select distinct region_code from svitlo_geo.routes where active
 and operator_id in(select operator_id from svitlo_discovery.operator_turn)
) x;
select jsonb_build_object('kind','directories','rows',jsonb_agg(x)) from (
 select operator_id,region_code,enabled,status,directory_complete,last_attempt_at,last_success_at,next_at,error_code,
 summary->>'routes' routes,summary->>'mapped' mapped,summary->>'queueLookup' queue_lookup,
 summary->>'directoryScope' directory_scope,summary->>'acceptedRows' accepted_rows,summary->>'skippedRows' skipped_rows
 from svitlo_discovery.regional_sources order by region_code,operator_id
) x;
select jsonb_build_object('kind','routes','rows',jsonb_agg(x)) from (
 select l.settlement_code,l.route_id,l.candidate_count,l.match_state
 from svitlo_geo.route_places l join svitlo_geo.routes r on r.id=l.route_id
 where r.active and r.operator_id in(select operator_id from svitlo_discovery.operator_turn)
) x;
select jsonb_build_object('kind','jobs','rows',jsonb_agg(x)) from (
 select cluster_code,settlement_code,scope_status,kind,count(*)::int total,
 count(*) filter(where completed_at is not null)::int checked,
 count(*) filter(where attempts>0)::int attempted,
 count(*) filter(where last_error is not null)::int retrying,
 count(*) filter(where exists(select 1 from svitlo_discovery.territory_routes tr cross join svitlo_discovery.territory_current tc where tr.route_id=j.route_id and tr.held and tc.expires_at>now()))::int territory_held,
 max(last_attempt_at) last_attempt
 from svitlo_discovery.jobs j group by cluster_code,settlement_code,scope_status,kind
) x;
select jsonb_build_object('kind','events','rows',jsonb_agg(x)) from (
 select cluster_code,settlement_code,outcome,grouping(outcome)::int summary,
 count(distinct(route_id,subject_key))::int subjects,
 count(distinct(route_id,subject_key)) filter(where kind='house')::int house_refs,
 max(last_seen_at) last_seen
 from svitlo_discovery.events
 group by grouping sets ((cluster_code,settlement_code,outcome),(cluster_code,settlement_code))
) x;
select jsonb_build_object('kind','active','rows',jsonb_agg(x)) from (
 select operator_id,active_cluster_code,last_claimed_at,consecutive_failures,cooldown_level,
 case when greatest(cooldown_until,svitlo_discovery.source_available_at(operator_id))>now() then greatest(cooldown_until,svitlo_discovery.source_available_at(operator_id)) else null end paused_until
 from svitlo_discovery.operator_turn order by operator_id
) x;
select jsonb_build_object('kind','state','rows',jsonb_agg(x)) from (
 select p.enabled,p.interval_seconds,p.source_interval_seconds,p.failure_threshold,p.daily_limit,s.daily_claims,s.day_key,
 s.last_claim_at,s.last_success_at from svitlo_discovery.policy p cross join svitlo_discovery.state s
) x;
select jsonb_build_object('kind','territory','rows',jsonb_agg(x)) from (
 select tc.checked_at,tc.expires_at,tc.expires_at>now() fresh,e.metadata->>'sourceUpdatedAt' source_updated_at,
 e.metadata->>'asOfDate' as_of_date,e.metadata->>'sourcePage' source_page,e.hash edition
 from svitlo_discovery.territory_current tc join svitlo_discovery.territory_editions e on e.hash=tc.edition_hash
) x;
commit;
