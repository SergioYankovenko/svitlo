-- Additive, bounded public-plan projection. No profile, sensor, raw payload,
-- credential, observation hash or collector control is exposed to the API role.
grant usage on schema svitlo_source_history to svitlo_stage_api;
create function svitlo_source_history.plan_observations(group_key text,plan_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare first_ms bigint;last_ms bigint;result jsonb;
begin
 if group_key is null or group_key !~ '^GPV[1-9][0-9]{0,2}\.[1-9][0-9]?$' or plan_day is null or
  plan_day>(now() at time zone 'Europe/Kyiv')::date or plan_day<(now() at time zone 'Europe/Kyiv')::date-90 then
  raise exception 'invalid plan history range';
 end if;
 first_ms:=(extract(epoch from (plan_day::timestamp at time zone 'Europe/Kyiv'))*1000)::bigint-300000;
 last_ms:=(extract(epoch from ((plan_day+1)::timestamp at time zone 'Europe/Kyiv'))*1000)::bigint;
 select coalesce(jsonb_agg(jsonb_build_object(
  'observedAt',c.finished_at,'state',d->>'state','classification',d->>'classification',
  'applicability',d#>>'{evidence,applicability}','intervalComparison',d#>>'{evidence,intervalComparison}',
  'primaryCheckedAt',d#>'{evidence,primaryCheckedAt}','secondaryCheckedAt',d#>'{evidence,secondaryCheckedAt}',
  'intervals',d->'intervals') order by c.slot),'[]'::jsonb) into result
 from (select slot,finished_at,comparisons,state from svitlo_source_history.cycles
  where slot>=first_ms and slot<last_ms order by slot limit 400)c
 left join lateral(select x from jsonb_array_elements(c.comparisons)x
  where c.state='complete' and x->>'group'=group_key and x->>'date'=plan_day::text limit 1) choice on true
 cross join lateral(select choice.x as d) projected;
 return result;
end $$;
alter function svitlo_source_history.plan_observations(text,date) owner to svitlo_region_owner;
revoke all on function svitlo_source_history.plan_observations(text,date) from public;
grant execute on function svitlo_source_history.plan_observations(text,date) to svitlo_stage_api,svitlo_stage_worker;
