-- Existing client contracts are unchanged. All coordination remains service-only.
alter table public.svitlo_profiles add column snapshot_revision bigint not null default 0;
create unique index svitlo_profiles_exact_address on public.svitlo_profiles
 (owner,(address->>'department'),(address->>'cityId'),(address->>'streetId'),(address->>'house'));
create index svitlo_subscriptions_profile_id on public.svitlo_subscriptions(profile_id);
create index svitlo_deliveries_profile_id on public.svitlo_deliveries(profile_id);

create function public.svitlo_profile_create(subject uuid,profile_id uuid,address_data jsonb,display_name text,preference_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.svitlo_profiles; k text;
begin
 foreach k in array array['department','cityId','streetId','house'] loop
  if jsonb_typeof(address_data->k) is distinct from 'string' or length(address_data->>k) not between 1 and 120 then
   raise exception 'invalid address';
  end if;
 end loop;
 -- Serializes quota and identity checks even when no address row exists yet.
 perform pg_advisory_xact_lock(hashtextextended('svitlo-profile-owner:'||subject::text,0));
 select * into p from public.svitlo_profiles where owner=subject
  and address->>'department'=address_data->>'department' and address->>'cityId'=address_data->>'cityId'
  and address->>'streetId'=address_data->>'streetId' and address->>'house'=address_data->>'house';
 if found then return jsonb_build_object('created',false,'profile',to_jsonb(p)); end if;
 if (select count(*) from public.svitlo_profiles where owner=subject)>=10 then
  return jsonb_build_object('status','limit');
 end if;
 insert into public.svitlo_profiles(id,owner,address,name,preferences,lease_until)
 values(profile_id,subject,address_data,left(coalesce(display_name,''),60),preference_data,
  (extract(epoch from clock_timestamp())*1000)::bigint+180000) returning * into p;
 return jsonb_build_object('created',true,'profile',to_jsonb(p));
end $$;

create function public.svitlo_profile_commit(subject uuid,profile_id uuid,expected_revision bigint,profile_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.svitlo_profiles;
begin
 if jsonb_typeof(profile_data->'snapshot') is distinct from 'object' or jsonb_typeof(profile_data->'messages') is distinct from 'array'
  then raise exception 'invalid profile result'; end if;
 -- UPDATE only: a deleted profile can never be resurrected by a delayed refresh.
 -- User-owned fields (address/name/preferences) are deliberately absent here.
 update public.svitlo_profiles set snapshot=profile_data->'snapshot',messages=profile_data->'messages',
  last_checked=(profile_data->>'last_checked')::bigint,next_check=(profile_data->>'next_check')::bigint,
  snapshot_revision=snapshot_revision+1,lease_until=0
 where id=profile_id and owner=subject and snapshot_revision=expected_revision
  and last_checked<=(profile_data->>'last_checked')::bigint returning * into p;
 if found then return jsonb_build_object('status','updated','profile',to_jsonb(p)); end if;
 select * into p from public.svitlo_profiles where id=profile_id and owner=subject;
 return jsonb_build_object('status',case when found then 'conflict' else 'missing' end,'profile',case when found then to_jsonb(p) end);
end $$;

create table public.svitlo_feed_state (
 id boolean primary key default true check(id), token uuid,lease_until bigint not null default 0,
 next_refresh bigint not null default 0,last_error text
);
insert into public.svitlo_feed_state(id) values(true);
create function public.svitlo_feed_claim() returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.svitlo_feed_state; v jsonb; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; claim uuid;
begin
 select * into s from public.svitlo_feed_state where id for update;
 select value into v from public.svitlo_cache where key='feed';
 if s.last_error is not null and v is not null then v:=v||jsonb_build_object('partial',true,'feedError',s.last_error); end if;
 if s.next_refresh>t and v is not null then return jsonb_build_object('state','fresh','value',v); end if;
 if s.lease_until>t then return jsonb_build_object('state','busy','value',v); end if;
 claim:=gen_random_uuid();
 update public.svitlo_feed_state set token=claim,lease_until=t+35000 where id;
 return jsonb_build_object('state','owner','token',claim,'value',v);
end $$;
create function public.svitlo_feed_finish(claim uuid,feed_value jsonb,error_code text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare s public.svitlo_feed_state; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 select * into s from public.svitlo_feed_state where id for update;
 if s.token is distinct from claim or s.lease_until<t then return false; end if;
 if feed_value is not null then
  if jsonb_typeof(feed_value) is distinct from 'object' or jsonb_typeof(feed_value->'plans') is distinct from 'array'
   or jsonb_typeof(feed_value->'emergencies') is distinct from 'array' then raise exception 'invalid feed'; end if;
  insert into public.svitlo_cache(key,value) values('feed',feed_value) on conflict(key) do update set value=excluded.value;
 end if;
 update public.svitlo_feed_state set token=null,lease_until=0,
  next_refresh=t+case when error_code is not null then 60000 when coalesce((feed_value->>'partial')::boolean,false) then 300000 else 3600000 end,
  last_error=left(coalesce(error_code,case when (feed_value->>'partial')::boolean then coalesce(feed_value->>'feedError','invalid_response') end),40)
 where id;
 return true;
end $$;

create table public.svitlo_jobs_state (
 id boolean primary key default true check(id),token uuid,lease_until bigint not null default 0,reminder_cursor uuid
);
insert into public.svitlo_jobs_state(id) values(true);
create function public.svitlo_jobs_claim() returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.svitlo_jobs_state; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; claim uuid;
begin
 select * into s from public.svitlo_jobs_state where id for update;
 if s.lease_until>t then return jsonb_build_object('granted',false); end if;
 claim:=gen_random_uuid();
 update public.svitlo_jobs_state set token=claim,lease_until=t+55000 where id;
 return jsonb_build_object('granted',true,'token',claim,'cursor',s.reminder_cursor);
end $$;
create function public.svitlo_jobs_finish(claim uuid,cursor_id uuid) returns boolean language sql security invoker set search_path='' as $$
 with finished as(update public.svitlo_jobs_state set token=null,lease_until=0,reminder_cursor=cursor_id
  where id and token=claim returning id) select exists(select 1 from finished);
$$;

alter table public.svitlo_deliveries add column lease_token uuid;
create function public.svitlo_delivery_claim(now_ms bigint) returns jsonb language sql security invoker set search_path='' as $$
 with claimed as (
  update public.svitlo_deliveries d set lease_until=now_ms+30000,lease_token=gen_random_uuid(),attempts=attempts+1
  where d.id=(select q.id from public.svitlo_deliveries q where not q.sent and q.attempts<5
   and q.expires_at>now_ms and q.lease_until<now_ms order by q.id limit 1 for update skip locked) returning d.*
 ) select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('subscription',s.subscription)),'[]'::jsonb)
 from claimed c join public.svitlo_subscriptions s on s.id=c.subscription_id;
$$;
create function public.svitlo_delivery_finish(delivery_id bigint,claim uuid,delivered boolean,retry_at bigint) returns boolean
language sql security invoker set search_path='' as $$
 with finished as(update public.svitlo_deliveries set sent=coalesce(delivered,sent),
 attempts=greatest(0,attempts-case when delivered is null then 1 else 0 end),
 lease_until=case when delivered then 0 else retry_at end,lease_token=null
 where id=delivery_id and lease_token=claim returning id) select exists(select 1 from finished);
$$;

alter table public.svitlo_feed_state enable row level security;
alter table public.svitlo_jobs_state enable row level security;
revoke all on public.svitlo_feed_state,public.svitlo_jobs_state from public,anon,authenticated;
grant all on public.svitlo_feed_state,public.svitlo_jobs_state to service_role;
revoke all on function public.svitlo_profile_create(uuid,uuid,jsonb,text,jsonb),public.svitlo_profile_commit(uuid,uuid,bigint,jsonb),
 public.svitlo_feed_claim(),public.svitlo_feed_finish(uuid,jsonb,text),public.svitlo_jobs_claim(),public.svitlo_jobs_finish(uuid,uuid),
 public.svitlo_delivery_claim(bigint),public.svitlo_delivery_finish(bigint,uuid,boolean,bigint) from public,anon,authenticated;
grant execute on function public.svitlo_profile_create(uuid,uuid,jsonb,text,jsonb),public.svitlo_profile_commit(uuid,uuid,bigint,jsonb),
 public.svitlo_feed_claim(),public.svitlo_feed_finish(uuid,jsonb,text),public.svitlo_jobs_claim(),public.svitlo_jobs_finish(uuid,uuid),
 public.svitlo_delivery_claim(bigint),public.svitlo_delivery_finish(bigint,uuid,boolean,bigint) to service_role;
