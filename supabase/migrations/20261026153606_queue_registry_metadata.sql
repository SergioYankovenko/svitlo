-- Small, current projection for exact address catalog matches. No payload cache.
create function public.svitlo_queue_metadata()
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.payload->'id',
    'validFrom', v.payload->'validFrom',
    'validUntil', v.payload->'validUntil',
    'documents', coalesce((
      select jsonb_agg(
        jsonb_build_object('queue', d.doc->'queue', 'url', d.doc->'url')
        order by d.position
      )
      from jsonb_array_elements(v.payload->'documents')
        with ordinality as d(doc, position)
    ), '[]'::jsonb)
  )
  from public.svitlo_queue_versions v
  where v.active = true;
$$;
revoke all on function public.svitlo_queue_metadata() from public, anon, authenticated;
grant execute on function public.svitlo_queue_metadata() to service_role;
