-- Additive, service-only scaling. Existing RPCs remain for a staged server rollout.
create table public.svitlo_shared_plans(id text primary key, plans jsonb not null, created_at timestamptz not null default now());
create table public.svitlo_source_cache(key text primary key, value jsonb, expires_at bigint not null default 0,
 token uuid, lease_until bigint not null default 0, touched_at bigint not null default 0);
create index svitlo_source_cache_expiry on public.svitlo_source_cache(touched_at);
alter table public.svitlo_profiles add column push_enabled boolean not null default false;
create index svitlo_push_due on public.svitlo_profiles(next_check,last_checked) where push_enabled;
create table public.svitlo_reminder_tasks(profile_id uuid primary key references public.svitlo_profiles(id) on delete cascade,
 due_at bigint not null default 0, generation uuid not null default gen_random_uuid(), token uuid, lease_until bigint not null default 0);
create index svitlo_reminder_due on public.svitlo_reminder_tasks(due_at) where due_at>0;
alter table public.svitlo_deliveries add column channel text, add column generation uuid, add column cancelled boolean not null default false;
create index svitlo_delivery_ready on public.svitlo_deliveries(lease_until,id) where not sent and not cancelled;

create function public.svitlo_has_push(p public.svitlo_profiles) returns boolean language sql stable set search_path='' as $$
 select (p.preferences->'schedule' is distinct from 'false'::jsonb or p.preferences->'emergency' is distinct from 'false'::jsonb
 or p.preferences->'reminder' is distinct from 'false'::jsonb or p.preferences->'restoration' is distinct from 'false'::jsonb)
 and exists(select 1 from public.svitlo_subscriptions s where s.owner=p.owner and (s.profile_id=p.id or s.profile_id is null));
$$;
create function public.svitlo_hydrate(p public.svitlo_profiles) returns public.svitlo_profiles language plpgsql stable set search_path='' as $$
begin
 if p.snapshot ? '_plansRef' then
  p.snapshot:=(p.snapshot-'_plansRef')||jsonb_build_object('plans',coalesce((select plans from public.svitlo_shared_plans where id=p.snapshot->>'_plansRef'),'[]'::jsonb));
 elsif jsonb_typeof(p.snapshot->'plans')='array' then
  p.snapshot:=jsonb_set(p.snapshot,'{plans}',coalesce((select jsonb_agg(x) from jsonb_array_elements(p.snapshot->'plans') x where x->>'queue'=p.snapshot->>'queue'),'[]'::jsonb));
 end if;
 return p;
end $$;
create function public.svitlo_profiles_read(subject uuid,profile_id uuid default null) returns setof public.svitlo_profiles
language sql stable set search_path='' as $$ select (public.svitlo_hydrate(p)).* from public.svitlo_profiles p where p.owner=subject and (profile_id is null or p.id=profile_id) order by p.created_at; $$;
create function public.svitlo_profile_commit_v2(subject uuid,profile_id uuid,expected_revision bigint,profile_data jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare plans jsonb; ref text; result jsonb; p public.svitlo_profiles;
begin
 select coalesce(jsonb_agg(x),'[]'::jsonb) into plans from jsonb_array_elements(coalesce(profile_data#>'{snapshot,plans}','[]'::jsonb)) x
 where x->>'queue'=profile_data#>>'{snapshot,queue}';
 ref:=md5(plans::text);
 insert into public.svitlo_shared_plans(id,plans) values(ref,plans) on conflict do nothing;
 profile_data:=jsonb_set(profile_data,'{snapshot}',(profile_data->'snapshot')||jsonb_build_object('plans','[]'::jsonb,'_plansRef',ref));
 result:=public.svitlo_profile_commit(subject,profile_id,expected_revision,profile_data);
 if result->>'status'<>'missing' then
  select * into p from public.svitlo_profiles where id=profile_id and owner=subject;
  result:=jsonb_set(result,'{profile}',to_jsonb(public.svitlo_hydrate(p)));
 end if;
 return result;
end $$;

create function public.svitlo_profile_work_changed() returns trigger language plpgsql set search_path='' as $$
declare t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 new.push_enabled:=public.svitlo_has_push(new);
 if tg_op='INSERT' or new.snapshot is distinct from old.snapshot or new.preferences is distinct from old.preferences
  or new.address is distinct from old.address or new.push_enabled is distinct from old.push_enabled or new.snapshot_revision is distinct from old.snapshot_revision then
  -- The AFTER trigger handles the task FK once the new profile exists.
  if new.push_enabled and (tg_op='INSERT' or not old.push_enabled) then new.next_check:=least(new.next_check,t); end if;
 end if;
 return new;
end $$;
create trigger svitlo_profile_work_before before insert or update of snapshot,preferences,address,push_enabled,snapshot_revision on public.svitlo_profiles
for each row execute function public.svitlo_profile_work_changed();
create function public.svitlo_profile_task_changed() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' or new.snapshot is distinct from old.snapshot or new.preferences is distinct from old.preferences
  or new.address is distinct from old.address or new.push_enabled is distinct from old.push_enabled or new.snapshot_revision is distinct from old.snapshot_revision then
  insert into public.svitlo_reminder_tasks(profile_id,due_at) values(new.id,case when new.push_enabled and
   (new.preferences->'reminder' is distinct from 'false'::jsonb or new.preferences->'restoration' is distinct from 'false'::jsonb)
   then (extract(epoch from clock_timestamp())*1000)::bigint else 0 end)
  on conflict(profile_id) do update set due_at=excluded.due_at,generation=gen_random_uuid(),token=null,lease_until=0;
 end if;
 return new;
end $$;
create trigger svitlo_profile_task_after after insert or update of snapshot,preferences,address,push_enabled,snapshot_revision on public.svitlo_profiles
for each row execute function public.svitlo_profile_task_changed();
create function public.svitlo_subscription_work_changed() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.owner=old.owner and new.profile_id is not distinct from old.profile_id and new.subscription=old.subscription then return null; end if;
 if tg_op<>'INSERT' then update public.svitlo_profiles p set push_enabled=public.svitlo_has_push(p) where owner=old.owner; end if;
 if tg_op<>'DELETE' then update public.svitlo_profiles p set push_enabled=public.svitlo_has_push(p) where owner=new.owner; end if;
 if tg_op<>'DELETE' then
  update public.svitlo_reminder_tasks t set due_at=(extract(epoch from clock_timestamp())*1000)::bigint
   from public.svitlo_profiles p where p.id=t.profile_id and p.owner=new.owner and p.push_enabled
   and (new.profile_id is null or new.profile_id=p.id) and
   (p.preferences->'reminder' is distinct from 'false'::jsonb or p.preferences->'restoration' is distinct from 'false'::jsonb);
 end if;
 return null;
end $$;
create trigger svitlo_subscription_work after insert or update or delete on public.svitlo_subscriptions for each row execute function public.svitlo_subscription_work_changed();
update public.svitlo_profiles p set push_enabled=public.svitlo_has_push(p);

create function public.svitlo_due_v2(now_ms bigint,batch_size integer) returns setof public.svitlo_profiles language sql set search_path='' as $$
 with claimed as (update public.svitlo_profiles p set lease_until=now_ms+60000 where p.id in
 (select id from public.svitlo_profiles where push_enabled and ((next_check>0 and next_check<=now_ms) or (next_check=0 and last_checked<now_ms-3600000))
 and lease_until<now_ms order by next_check,last_checked limit greatest(1,least(batch_size,4)) for update skip locked) returning p.*)
 select (public.svitlo_hydrate(c)).* from claimed c;
$$;
create function public.svitlo_reminder_claim(now_ms bigint,batch_size integer) returns jsonb language sql set search_path='' as $$
 with claimed as (update public.svitlo_reminder_tasks t set token=gen_random_uuid(),lease_until=now_ms+55000 where t.profile_id in
 (select q.profile_id from public.svitlo_reminder_tasks q join public.svitlo_profiles p on p.id=q.profile_id
 where p.push_enabled and q.due_at>0 and q.due_at<=now_ms and q.lease_until<now_ms order by q.due_at,q.profile_id
 limit greatest(1,least(batch_size,300)) for update of q skip locked) returning t.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'owner',p.owner,'preferences',p.preferences,'snapshot',(public.svitlo_hydrate(p)).snapshot,
 'generation',t.generation,'token',t.token)),'[]'::jsonb) from claimed t join public.svitlo_profiles p on p.id=t.profile_id;
$$;
create function public.svitlo_enqueue_v2(event jsonb) returns void language sql set search_path='' as $$
 insert into public.svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at,channel,generation)
 select s.id,p.id,md5(event->>'event_key'),event->>'title',event->>'body',event->>'date',(event->>'expires_at')::bigint,event->>'channel',(event->>'generation')::uuid
 from public.svitlo_profiles p join public.svitlo_subscriptions s on s.owner=p.owner and (s.profile_id=p.id or s.profile_id is null)
 where p.id=(event->>'profile_id')::uuid and p.owner=(event->>'owner')::uuid and p.push_enabled
 and (event->>'channel' is null or p.preferences->(event->>'channel') is distinct from 'false'::jsonb)
 on conflict(subscription_id,profile_id,event_key) do update set generation=excluded.generation,channel=excluded.channel,
 title=excluded.title,body=excluded.body,date=excluded.date,expires_at=excluded.expires_at,cancelled=false,lease_until=0,lease_token=null,attempts=0
 where not svitlo_deliveries.sent and svitlo_deliveries.generation is distinct from excluded.generation;
$$;
create function public.svitlo_reminder_finish(items jsonb) returns integer language plpgsql set search_path='' as $$
declare i jsonb; t public.svitlo_reminder_tasks; p public.svitlo_profiles; n integer:=0;
begin
 for i in select value from jsonb_array_elements(items) loop
  select * into p from public.svitlo_profiles where id=(i->>'id')::uuid for update;
  if not found then continue; end if;
  select * into t from public.svitlo_reminder_tasks where profile_id=p.id for update;
  if t.token is distinct from (i->>'token')::uuid or t.generation is distinct from (i->>'generation')::uuid or not p.push_enabled then continue; end if;
  if i->'event' is not null and i->'event'<>'null'::jsonb then
   perform public.svitlo_enqueue_v2((i->'event')||jsonb_build_object('profile_id',p.id,'owner',p.owner,'generation',t.generation));
  end if;
  update public.svitlo_reminder_tasks set due_at=greatest(0,(i->>'next_due')::bigint),token=null,lease_until=0 where profile_id=p.id;
  n:=n+1;
 end loop;
 return n;
end $$;
create function public.svitlo_feed_work_changed() returns trigger language plpgsql set search_path='' as $$
declare t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if new.key='feed' and (tg_op='INSERT' or new.value->'plans' is distinct from old.value->'plans' or new.value->'emergencies' is distinct from old.value->'emergencies') then
  update public.svitlo_profiles set next_check=least(next_check,t) where push_enabled;
  update public.svitlo_reminder_tasks q set due_at=0,generation=gen_random_uuid(),token=null,lease_until=0
   from public.svitlo_profiles p where p.id=q.profile_id and p.push_enabled;
 end if;
 return null;
end $$;
create trigger svitlo_feed_work after insert or update on public.svitlo_cache for each row execute function public.svitlo_feed_work_changed();

create function public.svitlo_delivery_valid(d public.svitlo_deliveries,now_ms bigint) returns boolean language sql stable set search_path='' as $$
 select not d.cancelled and not d.sent and d.expires_at>now_ms and exists(select 1 from public.svitlo_profiles p
 join public.svitlo_subscriptions s on s.id=d.subscription_id and s.owner=p.owner and (s.profile_id=p.id or s.profile_id is null)
 left join public.svitlo_reminder_tasks t on t.profile_id=p.id
 where p.id=d.profile_id and p.push_enabled and (d.channel is null or p.preferences->d.channel is distinct from 'false'::jsonb)
 and (d.generation is null or d.generation=t.generation));
$$;
create function public.svitlo_delivery_batch(now_ms bigint,batch_size integer) returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 update public.svitlo_deliveries d set cancelled=true where not sent and not cancelled and not public.svitlo_delivery_valid(d,now_ms);
 with claimed as (update public.svitlo_deliveries d set lease_until=now_ms+55000,lease_token=gen_random_uuid(),attempts=attempts+1 where d.id in
 (select q.id from public.svitlo_deliveries q where not q.sent and not q.cancelled and q.attempts<5 and q.expires_at>now_ms and q.lease_until<now_ms
 order by q.id limit greatest(1,least(batch_size,16)) for update skip locked) returning d.*)
 select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('subscription',s.subscription)),'[]'::jsonb) into result
 from claimed c join public.svitlo_subscriptions s on s.id=c.subscription_id;
 return result;
end $$;
create function public.svitlo_delivery_active(claims jsonb,now_ms bigint) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(d.id),'[]'::jsonb) from public.svitlo_deliveries d join jsonb_array_elements(claims) c
 on d.id=(c->>'id')::bigint and d.lease_token=(c->>'token')::uuid where public.svitlo_delivery_valid(d,now_ms);
$$;
create function public.svitlo_delivery_finish_batch(items jsonb) returns integer language sql set search_path='' as $$
 with finished as(update public.svitlo_deliveries d set sent=coalesce((i->>'delivered')::boolean,d.sent),
 attempts=greatest(0,d.attempts-case when i->>'delivered' is null then 1 else 0 end),
 lease_until=case when (i->>'delivered')::boolean then 0 else (i->>'retry_at')::bigint end,lease_token=null
 from jsonb_array_elements(items) i where d.id=(i->>'id')::bigint and d.lease_token=(i->>'token')::uuid returning d.id)
 select count(*)::integer from finished;
$$;
create function public.svitlo_source_claim(cache_key text,now_ms bigint) returns jsonb language plpgsql set search_path='' as $$
declare c public.svitlo_source_cache; claim uuid;
begin
 insert into public.svitlo_source_cache(key,touched_at) values(cache_key,now_ms) on conflict do nothing;
 select * into c from public.svitlo_source_cache where key=cache_key for update;
 if c.expires_at>now_ms and c.value is not null then return jsonb_build_object('state','fresh','value',c.value); end if;
 if c.lease_until>now_ms then return jsonb_build_object('state','busy'); end if;
 claim:=gen_random_uuid();update public.svitlo_source_cache set token=claim,lease_until=now_ms+25000,touched_at=now_ms where key=cache_key;
 return jsonb_build_object('state','owner','token',claim);
end $$;
create function public.svitlo_source_finish(cache_key text,claim uuid,cache_value jsonb,now_ms bigint,ttl_ms integer) returns boolean language sql set search_path='' as $$
 with finished as(update public.svitlo_source_cache set token=null,lease_until=0,value=coalesce(cache_value,value),
 expires_at=case when cache_value is null then 0 else now_ms+least(greatest(ttl_ms,0),1800000) end,touched_at=now_ms
 where key=cache_key and token=claim and lease_until>=now_ms returning key) select exists(select 1 from finished);
$$;
create function public.svitlo_scaling_cleanup() returns void language sql set search_path='' as $$
 delete from public.svitlo_shared_plans s where s.created_at<now()-interval '7 days'
 and not exists(select 1 from public.svitlo_profiles p where p.snapshot->>'_plansRef'=s.id);
$$;

-- No client can call these RPCs or inspect account-scoped cache entries.
alter table public.svitlo_shared_plans enable row level security;
alter table public.svitlo_source_cache enable row level security;
alter table public.svitlo_reminder_tasks enable row level security;
revoke all on public.svitlo_shared_plans,public.svitlo_source_cache,public.svitlo_reminder_tasks from public,anon,authenticated;
grant all on public.svitlo_shared_plans,public.svitlo_source_cache,public.svitlo_reminder_tasks to service_role;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('svitlo_has_push','svitlo_hydrate','svitlo_profiles_read','svitlo_profile_commit_v2','svitlo_profile_work_changed','svitlo_profile_task_changed',
 'svitlo_subscription_work_changed','svitlo_due_v2','svitlo_reminder_claim','svitlo_enqueue_v2','svitlo_reminder_finish','svitlo_feed_work_changed',
 'svitlo_delivery_valid','svitlo_delivery_batch','svitlo_delivery_active','svitlo_delivery_finish_batch','svitlo_source_claim','svitlo_source_finish','svitlo_scaling_cleanup') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
