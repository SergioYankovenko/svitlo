-- Private service-only projection. The minute worker never needs an address,
-- message history, unrelated queues, or a week's publication history.
create function public.svitlo_reminder_profiles(now_ms bigint,batch_size integer default 100,after_id uuid default null)
returns table(id uuid,owner uuid,preferences jsonb,snapshot jsonb)
language sql stable security invoker set search_path=public as $$
 with bounds as (
  select (to_timestamp(now_ms/1000.0) at time zone 'Europe/Kyiv')::date as today
 ), selected as materialized (
  select p.id,p.owner,p.preferences,p.snapshot from public.svitlo_profiles p
  where p.last_checked>now_ms-7200000 and (after_id is null or p.id>after_id)
    and (p.preferences->'reminder' is distinct from 'false'::jsonb
      or p.preferences->'restoration' is distinct from 'false'::jsonb)
  order by p.id limit greatest(1,least(coalesce(batch_size,100),100))
 )
 select p.id,p.owner,p.preferences,jsonb_build_object(
  'queue',p.snapshot->'queue',
  'plans',coalesce((select jsonb_agg(plan) from jsonb_array_elements(case when jsonb_typeof(p.snapshot->'plans')='array' then p.snapshot->'plans' else '[]'::jsonb end) plan
    where plan->>'queue'=p.snapshot->>'queue' and plan->>'date' in (b.today::text,(b.today+1)::text)),'[]'::jsonb),
  'categories',p.snapshot->'categories','failures',p.snapshot->'failures',
  'feedCheckedAt',p.snapshot->'feedCheckedAt','feedFailed',p.snapshot->'feedFailed',
  'emergencies',p.snapshot->'emergencies')
 from selected p cross join bounds b order by p.id
$$;
revoke all on function public.svitlo_reminder_profiles(bigint,integer,uuid) from public,anon,authenticated;
grant execute on function public.svitlo_reminder_profiles(bigint,integer,uuid) to service_role;
