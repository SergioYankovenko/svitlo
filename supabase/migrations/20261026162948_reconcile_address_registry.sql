-- Keep the curated census immutable; bind later PDF changes to their own version.
create table public.svitlo_address_queue_overrides (
 version_id text not null references public.svitlo_queue_versions(id),
 batch_id uuid not null,
 department text not null, city_id text not null, street_id text not null, house text not null,
 status text not null check(status in ('numeric','not_in_queue')),
 queue text,
 is_estimate boolean not null default false,
 confidence text check(confidence in ('high','medium','low')),
 evidence jsonb not null,
 primary key(version_id,batch_id,department,city_id,street_id,house),
 foreign key(batch_id,department,city_id,street_id,house)
  references public.svitlo_address_queues(batch_id,department,city_id,street_id,house),
 check((status='numeric' and queue is not null and queue ~ '^[1-6]\.[12]$') or (status='not_in_queue' and queue is null)),
 check((is_estimate and status='numeric' and confidence is not null) or (not is_estimate and confidence is null))
);
create index svitlo_address_override_source on public.svitlo_address_queue_overrides(batch_id,department,city_id,street_id,house);
alter table public.svitlo_address_queue_overrides enable row level security;
revoke all on public.svitlo_address_queue_overrides from public,anon,authenticated;
grant select,insert,update,delete on public.svitlo_address_queue_overrides to service_role;

create view public.svitlo_effective_address_queues with (security_invoker=true) as
select q.batch_id,q.department,q.city_id,q.street_id,q.house,q.city,q.street,
 case when o.version_id is null then q.status else o.status end as status,
 case when o.version_id is null then q.queue else o.queue end as queue,
 case when o.version_id is null then q.is_estimate else o.is_estimate end as is_estimate,
 case when o.version_id is null then q.confidence else o.confidence end as confidence,
 q.evidence || coalesce(o.evidence,'{}'::jsonb) as evidence,
 jsonb_build_object('import_key',b.import_key,'status',b.status,'reviewed_at',b.reviewed_at) as batch,
 o.version_id as override_registry_id
from public.svitlo_address_queues q
join public.svitlo_address_queue_batches b on b.id=q.batch_id and b.status='active'
left join public.svitlo_queue_versions v on v.active
left join public.svitlo_address_queue_overrides o on o.version_id=v.id and o.batch_id=q.batch_id
 and o.department=q.department and o.city_id=q.city_id and o.street_id=q.street_id and o.house=q.house;
revoke all on public.svitlo_effective_address_queues from public,anon,authenticated;
grant select on public.svitlo_effective_address_queues to service_role;

create or replace function public.svitlo_activate_registry(candidate jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare
 item jsonb; n integer:=0; old_id text; changed boolean;
 reconciliation jsonb:=candidate->'addressReconciliation'; batch_item jsonb;
 clean_candidate jsonb:=candidate-'addressReconciliation'; active_batches integer;
begin
 perform pg_advisory_xact_lock(743621);
 select id into old_id from public.svitlo_queue_versions where active;
 changed:=old_id is distinct from candidate->>'id';
 if coalesce(jsonb_array_length(candidate->'documents'),0)<>12
    or coalesce(jsonb_array_length(candidate->'rules'),0)<1 then
  raise exception 'Incomplete registry';
 end if;
 select count(*) into active_batches from public.svitlo_address_queue_batches where status='active';
 if changed and active_batches>0 then
  if reconciliation is null or reconciliation->>'previous_registry_id' is distinct from old_id
     or jsonb_typeof(reconciliation->'batches') is distinct from 'array'
     or jsonb_array_length(reconciliation->'batches')<>active_batches then
   raise exception 'Address reconciliation required';
  end if;
  if (select count(distinct x->>'batch_id') from jsonb_array_elements(reconciliation->'batches') x)<>active_batches then
   raise exception 'Duplicate address batch';
  end if;
  for batch_item in select value from jsonb_array_elements(reconciliation->'batches') loop
   if not exists(select 1 from public.svitlo_address_queue_batches b
      where b.id=(batch_item->>'batch_id')::uuid and b.status='active'
        and b.expected_total=(batch_item->>'total')::integer
        and b.expected_total=(select count(*) from public.svitlo_address_queues q where q.batch_id=b.id))
      or jsonb_typeof(batch_item->'overrides') is distinct from 'array'
      or jsonb_array_length(batch_item->'overrides')>(batch_item->>'total')::integer then
    raise exception 'Incomplete or superseded address batch';
   end if;
  end loop;
 end if;
 update public.svitlo_queue_versions set active=false where active;
 insert into public.svitlo_queue_versions(id,valid_from,valid_until,checked_at,payload,active)
 values(candidate->>'id',(candidate->>'validFrom')::date,(candidate->>'validUntil')::date,
        (candidate->>'checkedAt')::bigint,clean_candidate,true)
 on conflict(id) do update set checked_at=excluded.checked_at,payload=excluded.payload,active=true;
 delete from public.svitlo_queue_rules where version_id=candidate->>'id';
 for item in select value from jsonb_array_elements(candidate->'rules') loop
  insert into public.svitlo_queue_rules(version_id,ordinal,city,street,scope,queue,evidence)
  values(candidate->>'id',n,item->>'city',item->>'street',item->>'scope',item->>'queue',item);
  n:=n+1;
 end loop;
 if changed and active_batches>0 then
  for batch_item in select value from jsonb_array_elements(reconciliation->'batches') loop
   delete from public.svitlo_address_queue_overrides
    where version_id=candidate->>'id' and batch_id=(batch_item->>'batch_id')::uuid;
   for item in select value from jsonb_array_elements(batch_item->'overrides') loop
    if exists(select 1 from public.svitlo_address_queues q
      where q.batch_id=(batch_item->>'batch_id')::uuid and q.department=item->>'department'
       and q.city_id=item->>'city_id' and q.street_id=item->>'street_id' and q.house=item->>'house'
       and q.status='service') then
     raise exception 'Cannot override a service address';
    end if;
    insert into public.svitlo_address_queue_overrides
     (version_id,batch_id,department,city_id,street_id,house,status,queue,is_estimate,confidence,evidence)
    values(candidate->>'id',(batch_item->>'batch_id')::uuid,item->>'department',item->>'city_id',
     item->>'street_id',item->>'house',item->>'status',item->>'queue',
     (item->>'is_estimate')::boolean,item->>'confidence',item->'evidence');
   end loop;
  end loop;
 end if;
end;
$$;
revoke all on function public.svitlo_activate_registry(jsonb) from public,anon,authenticated;
grant execute on function public.svitlo_activate_registry(jsonb) to service_role;
