-- Private application data. Browser clients use authenticated Edge Functions only.
create table public.svitlo_profiles (
 id uuid primary key, owner uuid not null references auth.users(id) on delete cascade,
 address jsonb not null, name text not null default '', preferences jsonb not null default '{}',
 snapshot jsonb not null default '{}', messages jsonb not null default '[]',
 last_checked bigint not null default 0, lease_until bigint not null default 0,
 created_at timestamptz not null default now()
);
create index svitlo_profiles_owner on public.svitlo_profiles(owner);
create index svitlo_profiles_due on public.svitlo_profiles(last_checked,lease_until);
create table public.svitlo_cache(key text primary key,value jsonb not null);
create table public.svitlo_subscriptions (
 id text primary key, owner uuid not null references auth.users(id) on delete cascade,
 profile_id uuid references public.svitlo_profiles(id) on delete cascade,
 subscription jsonb not null, updated_at timestamptz not null default now()
);
create index svitlo_subscriptions_owner on public.svitlo_subscriptions(owner,profile_id);
create table public.svitlo_deliveries (
 id bigint generated always as identity primary key,
 subscription_id text not null references public.svitlo_subscriptions(id) on delete cascade,
 profile_id uuid not null references public.svitlo_profiles(id) on delete cascade,
 event_key text not null,title text not null,body text not null,date text not null,
 expires_at bigint not null,lease_until bigint not null default 0,sent boolean not null default false,
 attempts integer not null default 0,unique(subscription_id,profile_id,event_key)
);
create index svitlo_delivery_pending on public.svitlo_deliveries(lease_until,expires_at) where not sent;
create table public.svitlo_limits(owner uuid primary key,started_at bigint not null,count integer not null);
alter table public.svitlo_profiles enable row level security;
alter table public.svitlo_cache enable row level security;
alter table public.svitlo_subscriptions enable row level security;
alter table public.svitlo_deliveries enable row level security;
alter table public.svitlo_limits enable row level security;
revoke all on public.svitlo_profiles,public.svitlo_cache,public.svitlo_subscriptions,public.svitlo_deliveries,public.svitlo_limits from anon,authenticated;
grant all on public.svitlo_profiles,public.svitlo_cache,public.svitlo_subscriptions,public.svitlo_deliveries,public.svitlo_limits to service_role;
grant usage,select on sequence public.svitlo_deliveries_id_seq to service_role;

create function public.svitlo_rate(subject uuid,max_count integer,window_ms bigint) returns boolean
language plpgsql security invoker set search_path='' as $$
declare t bigint := (extract(epoch from clock_timestamp())*1000)::bigint; n integer;
begin
 insert into public.svitlo_limits as l values(subject,t,1)
 on conflict(owner) do update set
 count=case when l.started_at<t-window_ms then 1 else l.count+1 end,
 started_at=case when l.started_at<t-window_ms then t else l.started_at end returning count into n;
 return n<=max_count;
end $$;

create function public.svitlo_due(now_ms bigint,batch_size integer) returns setof public.svitlo_profiles
language sql security invoker set search_path='' as $$
 update public.svitlo_profiles set lease_until=now_ms+180000 where id in
 (select id from public.svitlo_profiles where last_checked<now_ms-3600000 and lease_until<now_ms
 order by last_checked limit least(batch_size,10) for update skip locked) returning *;
$$;
create function public.svitlo_enqueue(event jsonb) returns void language sql security invoker set search_path='' as $$
 insert into public.svitlo_deliveries(subscription_id,profile_id,event_key,title,body,date,expires_at)
 select s.id,(event->>'profile_id')::uuid,md5(event->>'event_key'),event->>'title',event->>'body',event->>'date',(event->>'expires_at')::bigint
 from public.svitlo_subscriptions s join public.svitlo_profiles p on p.id=(event->>'profile_id')::uuid and p.owner=s.owner
 where s.owner=(event->>'owner')::uuid and (s.profile_id is null or s.profile_id=p.id)
 on conflict(subscription_id,profile_id,event_key) do nothing;
$$;
create function public.svitlo_deliveries(now_ms bigint,batch_size integer)
returns table(id bigint,subscription_id text,profile_id uuid,event_key text,title text,body text,date text,subscription jsonb)
language sql security invoker set search_path='' as $$
 with claimed as (
 update public.svitlo_deliveries d set lease_until=now_ms+120000,attempts=attempts+1 where d.id in
 (select q.id from public.svitlo_deliveries q where not q.sent and q.attempts<5 and q.expires_at>now_ms and q.lease_until<now_ms
 order by q.id limit least(batch_size,50) for update skip locked) returning d.*)
 select c.id,c.subscription_id,c.profile_id,c.event_key,c.title,c.body,c.date,s.subscription from claimed c join public.svitlo_subscriptions s on s.id=c.subscription_id;
$$;
revoke all on function public.svitlo_rate(uuid,integer,bigint),public.svitlo_due(bigint,integer),public.svitlo_enqueue(jsonb),public.svitlo_deliveries(bigint,integer) from public,anon,authenticated;
grant execute on function public.svitlo_rate(uuid,integer,bigint),public.svitlo_due(bigint,integer),public.svitlo_enqueue(jsonb),public.svitlo_deliveries(bigint,integer) to service_role;
