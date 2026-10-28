-- Compatible channels and atomic preference patches. Apply before the new PWA/API/jobs.
create function public.svitlo_channel_enabled(p jsonb,channel text) returns boolean
language sql immutable security invoker set search_path='' as $$
 select case channel
 when 'publication' then coalesce(p->'publication',p->'schedule','true'::jsonb)<>'false'::jsonb
 when 'change' then coalesce(p->'change',p->'schedule','true'::jsonb)<>'false'::jsonb
 when 'address_emergency' then p->'emergency' is distinct from 'false'::jsonb
 when 'schedule' then coalesce(p->'publication',p->'schedule','true'::jsonb)<>'false'::jsonb and coalesce(p->'change',p->'schedule','true'::jsonb)<>'false'::jsonb
 else channel is null or p->channel is distinct from 'false'::jsonb end;
$$;
create function public.svitlo_merge_preferences(current_data jsonb,patch jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select current_data||jsonb_build_object(
 'publication',case when current_data->'_scheduleSplit' is distinct from 'true'::jsonb and not(patch?'publication' or patch?'change')
 then coalesce(patch->'schedule',current_data->'publication',current_data->'schedule','true'::jsonb)
 else coalesce(patch->'publication',current_data->'publication',current_data->'schedule','true'::jsonb) end,
 'change',case when current_data->'_scheduleSplit' is distinct from 'true'::jsonb and not(patch?'publication' or patch?'change')
 then coalesce(patch->'schedule',current_data->'change',current_data->'schedule','true'::jsonb)
 else coalesce(patch->'change',current_data->'change',current_data->'schedule','true'::jsonb) end,
 '_scheduleSplit',coalesce(current_data->'_scheduleSplit'='true'::jsonb,false) or patch?'publication' or patch?'change')||patch;
$$;
create function public.svitlo_preferences_compat() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if not(new.preferences?'_scheduleSplit') then
  new.preferences:=public.svitlo_merge_preferences(old.preferences,new.preferences);
 end if;
 return new;
end $$;
create trigger svitlo_preferences_compat_before before update of preferences on public.svitlo_profiles
for each row execute function public.svitlo_preferences_compat();
create function public.svitlo_preferences_patch(subject uuid,profile_id uuid,patch jsonb) returns void
language sql security invoker set search_path='' as $$
 update public.svitlo_profiles p set preferences=public.svitlo_merge_preferences(p.preferences,
 coalesce((select jsonb_object_agg(key,value) from jsonb_each(patch)
 where (key in ('schedule','publication','change','emergency','reminder','restoration') and jsonb_typeof(value)='boolean')
 or (key='lead' and value in ('5'::jsonb,'15'::jsonb,'30'::jsonb,'60'::jsonb))),'{}'::jsonb))
 where p.owner=subject and p.id=profile_id;
$$;
create or replace function public.svitlo_has_push(p public.svitlo_profiles) returns boolean language sql stable security invoker set search_path='' as $$
 select (public.svitlo_channel_enabled(p.preferences,'publication') or public.svitlo_channel_enabled(p.preferences,'change')
 or public.svitlo_channel_enabled(p.preferences,'address_emergency') or public.svitlo_channel_enabled(p.preferences,'reminder')
 or public.svitlo_channel_enabled(p.preferences,'restoration'))
 and exists(select 1 from public.svitlo_subscriptions s where s.owner=p.owner and (s.profile_id=p.id or s.profile_id is null));
$$;
create or replace function public.svitlo_enqueue_v2(event jsonb) returns void language sql set search_path='' as $$
 insert into public.svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at,channel,generation)
 select s.id,p.id,md5(event->>'event_key'),event->>'title',event->>'body',event->>'date',(event->>'expires_at')::bigint,event->>'channel',(event->>'generation')::uuid
 from public.svitlo_profiles p join public.svitlo_subscriptions s on s.owner=p.owner and (s.profile_id=p.id or s.profile_id is null)
 where p.id=(event->>'profile_id')::uuid and p.owner=(event->>'owner')::uuid and p.push_enabled
 and public.svitlo_channel_enabled(p.preferences,event->>'channel') and event->>'event_key' not like 'regional:%'
 on conflict(subscription_id,profile_id,event_key) do update set generation=excluded.generation,channel=excluded.channel,
 title=excluded.title,body=excluded.body,date=excluded.date,expires_at=excluded.expires_at,cancelled=false,lease_until=0,lease_token=null,attempts=0
 where not svitlo_deliveries.sent and svitlo_deliveries.generation is distinct from excluded.generation;
$$;
create or replace function public.svitlo_delivery_valid(d public.svitlo_deliveries,now_ms bigint) returns boolean language sql stable set search_path='' as $$
 select not d.cancelled and not d.sent and d.expires_at>now_ms and exists(select 1 from public.svitlo_profiles p
 join public.svitlo_subscriptions s on s.id=d.subscription_id and s.owner=p.owner and (s.profile_id=p.id or s.profile_id is null)
 left join public.svitlo_reminder_tasks t on t.profile_id=p.id
 where p.id=d.profile_id and p.push_enabled and public.svitlo_channel_enabled(p.preferences,d.channel)
 and not exists(select 1 from jsonb_array_elements(coalesce(p.messages,'[]'::jsonb)) m where m->>'scope'='region' and md5(m->>'id')=d.event_key)
 and (d.generation is null or d.generation=t.generation));
$$;

-- Normalize before an older client can replace the legacy four-field object.
update public.svitlo_profiles set preferences=preferences;
update public.svitlo_deliveries d set cancelled=true
where not d.sent and not d.cancelled and not public.svitlo_delivery_valid(d,(extract(epoch from clock_timestamp())*1000)::bigint);
revoke all on function public.svitlo_channel_enabled(jsonb,text),public.svitlo_preferences_patch(uuid,uuid,jsonb),public.svitlo_preferences_compat() from public,anon,authenticated;
grant execute on function public.svitlo_channel_enabled(jsonb,text),public.svitlo_preferences_patch(uuid,uuid,jsonb),public.svitlo_preferences_compat() to service_role;

revoke all on function public.svitlo_merge_preferences(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.svitlo_merge_preferences(jsonb,jsonb) to service_role;
