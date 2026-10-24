-- LOCAL migration only. Apply and schedule in production only after separate approval.
create table public.svitlo_queue_versions (
 id text primary key, valid_from date not null, valid_until date not null,
 checked_at bigint not null, active boolean not null default false,
 payload jsonb not null, check(valid_until>valid_from)
);
create unique index svitlo_queue_one_active on public.svitlo_queue_versions(active) where active;
create table public.svitlo_queue_rules (
 version_id text not null references public.svitlo_queue_versions(id),
 ordinal integer not null, city text not null, street text,
 scope text not null check(scope in ('house','street_all','settlement_all')),
 queue text not null check(queue ~ '^[1-6]\.[12]$'), evidence jsonb not null,
 primary key(version_id,ordinal)
);
create index svitlo_queue_lookup on public.svitlo_queue_rules(version_id,city,street);
alter table public.svitlo_queue_versions enable row level security;
alter table public.svitlo_queue_rules enable row level security;
revoke all on public.svitlo_queue_versions, public.svitlo_queue_rules from anon,authenticated;
grant all on public.svitlo_queue_versions, public.svitlo_queue_rules to service_role;
alter table public.svitlo_profiles add column next_check bigint not null default 0;
create index svitlo_profiles_next_check on public.svitlo_profiles(next_check,lease_until);
create or replace function public.svitlo_due(now_ms bigint,batch_size integer) returns setof public.svitlo_profiles
language sql security invoker set search_path='' as $$
 update public.svitlo_profiles set lease_until=now_ms+180000 where id in
 (select id from public.svitlo_profiles where
 ((next_check>0 and next_check<=now_ms) or (next_check=0 and last_checked<now_ms-3600000)) and lease_until<now_ms
 order by next_check,last_checked limit least(batch_size,10) for update skip locked) returning *;
$$;
-- Atomic activation, including all twelve documents and every rule. No browser execution grant.
create function public.svitlo_activate_registry(candidate jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare item jsonb; n integer:=0;
begin
 perform pg_advisory_xact_lock(743621);
 if jsonb_array_length(candidate->'documents')<>12 or jsonb_array_length(candidate->'rules')<1 then
  raise exception 'Incomplete registry';
 end if;
 update public.svitlo_queue_versions set active=false where active;
 insert into public.svitlo_queue_versions(id,valid_from,valid_until,checked_at,payload,active)
 values(candidate->>'id',(candidate->>'validFrom')::date,(candidate->>'validUntil')::date,(candidate->>'checkedAt')::bigint,candidate,true)
 on conflict(id) do update set checked_at=excluded.checked_at,payload=excluded.payload,active=true;
 -- Replace only this candidate's rows; prior version evidence remains available.
 delete from public.svitlo_queue_rules where version_id=candidate->>'id';
 for item in select value from jsonb_array_elements(candidate->'rules') loop
  insert into public.svitlo_queue_rules(version_id,ordinal,city,street,scope,queue,evidence)
  values(candidate->>'id',n,item->>'city',item->>'street',item->>'scope',item->>'queue',item);
  n:=n+1;
 end loop;
end;
$$;
revoke all on function public.svitlo_activate_registry(jsonb) from public,anon,authenticated;
grant execute on function public.svitlo_activate_registry(jsonb) to service_role;
