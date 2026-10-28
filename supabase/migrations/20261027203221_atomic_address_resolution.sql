-- Prepare the small queue-definition projection once per registry write.
-- Runtime lookups never read the large extracted PDF payload.
create table public.svitlo_queue_metadata_versions (
 version_id text primary key references public.svitlo_queue_versions(id) on update cascade on delete cascade,
 metadata jsonb not null check(jsonb_typeof(metadata)='object')
);
alter table public.svitlo_queue_metadata_versions enable row level security;
revoke all on public.svitlo_queue_metadata_versions from public,anon,authenticated;
grant select,insert,update,delete on public.svitlo_queue_metadata_versions to service_role;

create function public.svitlo_project_queue_metadata(registry_payload jsonb) returns jsonb
language sql immutable security invoker set search_path='' as $$
 select jsonb_build_object(
  'id',registry_payload->'id',
  'validFrom',registry_payload->'validFrom',
  'validUntil',registry_payload->'validUntil',
  'documents',coalesce((select jsonb_agg(jsonb_build_object('queue',d.doc->'queue','url',d.doc->'url') order by d.position)
   from jsonb_array_elements(registry_payload->'documents') with ordinality as d(doc,position)),'[]'::jsonb)
 );
$$;

create function public.svitlo_prepare_queue_metadata() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 insert into public.svitlo_queue_metadata_versions(version_id,metadata)
 values(new.id,public.svitlo_project_queue_metadata(new.payload))
 on conflict(version_id) do update set metadata=excluded.metadata
 where svitlo_queue_metadata_versions.metadata is distinct from excluded.metadata;
 return new;
end $$;
create trigger svitlo_prepare_queue_metadata_after
after insert or update of payload,id on public.svitlo_queue_versions
for each row execute function public.svitlo_prepare_queue_metadata();

-- Keep archived versions ready for an atomic rollback as well as the active one.
insert into public.svitlo_queue_metadata_versions(version_id,metadata)
select id,public.svitlo_project_queue_metadata(payload) from public.svitlo_queue_versions;

create or replace function public.svitlo_queue_metadata() returns jsonb
language sql stable security invoker set search_path='' as $$
 select m.metadata from public.svitlo_queue_versions v
 join public.svitlo_queue_metadata_versions m on m.version_id=v.id where v.active;
$$;

-- One SQL statement uses one MVCC snapshot for effective overrides and metadata.
-- Null record is a catalog miss, so the server can retain its full PDF fallback.
create function public.svitlo_address_resolution_data(department_id text,city_id text,street_id text,house_number text)
returns jsonb language sql stable security invoker set search_path='' as $$
 with record as materialized (
  select q.department,q.city_id,q.street_id,q.house,q.city,q.street,q.status,q.queue,q.is_estimate,q.confidence,q.evidence,q.batch
  from public.svitlo_effective_address_queues q
  where q.department=$1 and q.city_id=$2 and q.street_id=$3 and q.house=$4
 )
 select jsonb_build_object('record',(select to_jsonb(r) from record r),
  'registry',case when exists(select 1 from record r where r.status='numeric') then public.svitlo_queue_metadata() else null end);
$$;

revoke all on function public.svitlo_project_queue_metadata(jsonb),public.svitlo_prepare_queue_metadata(),
 public.svitlo_queue_metadata(),public.svitlo_address_resolution_data(text,text,text,text) from public,anon,authenticated;
grant execute on function public.svitlo_project_queue_metadata(jsonb),public.svitlo_prepare_queue_metadata(),
 public.svitlo_queue_metadata(),public.svitlo_address_resolution_data(text,text,text,text) to service_role;
