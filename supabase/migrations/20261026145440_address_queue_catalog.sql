create table public.svitlo_address_queue_batches (
 id uuid primary key default gen_random_uuid(),
 import_key text not null unique,
 department text not null check (department ~ '^[0-9]{1,3}$'),
 status text not null default 'staging' check (status in ('staging','active','archived')),
 expected_total integer not null check (expected_total > 0),
 expected_numeric integer not null,
 expected_exclusions integer not null,
 expected_service integer not null,
 checksum_md5 text not null check (checksum_md5 ~ '^[a-f0-9]{32}$'),
 reviewed_at timestamptz not null,
 created_at timestamptz not null default now(),
 activated_at timestamptz,
 metadata jsonb not null default '{}'::jsonb,
 check (expected_total = expected_numeric + expected_exclusions + expected_service)
);
create unique index svitlo_address_queue_one_active on public.svitlo_address_queue_batches (department) where status='active';
alter table public.svitlo_address_queue_batches enable row level security;
revoke all on public.svitlo_address_queue_batches from public,anon,authenticated;
grant select,insert,update,delete on public.svitlo_address_queue_batches to service_role;

create table public.svitlo_address_queues (
 batch_id uuid not null references public.svitlo_address_queue_batches(id) on delete restrict,
 department text not null,
 city_id text not null,
 street_id text not null,
 house text not null check (length(house) between 1 and 120),
 city text not null,
 street text not null,
 status text not null check (status in ('numeric','not_in_queue','service')),
 queue text,
 is_estimate boolean not null default false,
 confidence text check (confidence in ('high','medium','low')),
 evidence jsonb not null default '{}'::jsonb,
 primary key (batch_id,department,city_id,street_id,house),
 check ((status='numeric' and queue is not null and queue ~ '^[1-6]\.[12]$') or (status<>'numeric' and queue is null)),
 check (not is_estimate or status='numeric'),
 check ((is_estimate and confidence is not null) or (not is_estimate and confidence is null))
);
create index svitlo_address_queue_lookup on public.svitlo_address_queues (department,city_id,street_id,house,batch_id);
alter table public.svitlo_address_queues enable row level security;
revoke all on public.svitlo_address_queues from public,anon,authenticated;
grant select,insert,update,delete on public.svitlo_address_queues to service_role;

create function public.svitlo_address_dictionary(dictionary_kind text,parent_id text)
returns jsonb language sql stable security invoker set search_path=''
as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name collate "C",id collate "C"),'[]'::jsonb)
 from (
  select distinct q.department as id,'Христинівська філія'::text as name
  from public.svitlo_address_queues q join public.svitlo_address_queue_batches b on b.id=q.batch_id and b.status='active'
  where dictionary_kind='department' and q.department='18' and q.status<>'service'
  union all
  select distinct q.city_id,q.city from public.svitlo_address_queues q join public.svitlo_address_queue_batches b on b.id=q.batch_id and b.status='active'
  where dictionary_kind='city' and q.department=parent_id and q.status<>'service'
  union all
  select distinct q.street_id,q.street from public.svitlo_address_queues q join public.svitlo_address_queue_batches b on b.id=q.batch_id and b.status='active'
  where dictionary_kind='street' and q.city_id=parent_id and q.status<>'service'
  union all
  select distinct q.house,q.house from public.svitlo_address_queues q join public.svitlo_address_queue_batches b on b.id=q.batch_id and b.status='active'
  where dictionary_kind='house' and q.street_id=parent_id and q.status<>'service'
 ) entries;
$$;
revoke all on function public.svitlo_address_dictionary(text,text) from public,anon,authenticated;
grant execute on function public.svitlo_address_dictionary(text,text) to service_role;
