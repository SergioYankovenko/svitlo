-- ARCH-MOD-01-05. Additive provenance/review; no renumbering or name-based merges.
do $$ begin if not exists(select from pg_roles where rolname='svitlo_catalog_owner') then create role svitlo_catalog_owner nologin nobypassrls;end if;end $$;
create schema svitlo_catalog authorization svitlo_catalog_owner;
revoke all on schema svitlo_catalog from public;
grant usage on schema svitlo_vps to svitlo_catalog_owner;
grant select on svitlo_vps.catalog to svitlo_catalog_owner;
create table svitlo_catalog.name_aliases(
 id uuid primary key default gen_random_uuid(),entity_id uuid not null references svitlo_vps.catalog(id),
 label text not null check(length(label) between 1 and 240 and label!~'[[:cntrl:]]'),
 source_reference text not null check(length(source_reference) between 8 and 500),
 valid_from timestamptz not null,valid_until timestamptz,reviewed boolean not null default false,
 unique(entity_id,label,source_reference),check(valid_until is null or valid_until>valid_from)
);
create index catalog_alias_lookup on svitlo_catalog.name_aliases(entity_id) where reviewed;
create table svitlo_catalog.geography_links(
 entity_id uuid not null references svitlo_vps.catalog(id),place_code text not null references svitlo_geo.places(code),
 relation text not null check(relation in ('settlement','urban_district')),
 source_reference text not null check(length(source_reference) between 8 and 500),valid_from timestamptz not null,valid_until timestamptz,
 primary key(entity_id,place_code,relation),check(valid_until is null or valid_until>valid_from)
);
create index catalog_geo_scope on svitlo_catalog.geography_links(place_code,relation,entity_id);
create table svitlo_catalog.binding_reviews(
 address_id uuid not null references svitlo_vps.catalog(id),reason text not null check(reason in ('partial_binding','conflicting_binding','mapping_miss')),
 evidence jsonb not null,state text not null default 'open' check(state in ('open','accepted','dismissed')),
 first_seen_at timestamptz not null default clock_timestamp(),last_seen_at timestamptz not null default clock_timestamp(),
 observations integer not null default 1,primary key(address_id,reason)
);
create index catalog_review_pending on svitlo_catalog.binding_reviews(state,last_seen_at,address_id);
do $$ declare t text;begin foreach t in array array['name_aliases','geography_links','binding_reviews'] loop execute 'alter table svitlo_catalog.'||t||' owner to svitlo_catalog_owner';execute 'revoke all on svitlo_catalog.'||t||' from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session';end loop;end $$;
grant usage on schema svitlo_catalog to svitlo_stage_api,svitlo_stage_worker;
grant select on svitlo_catalog.name_aliases,svitlo_catalog.geography_links to svitlo_stage_worker;
create function svitlo_catalog.record_review(address uuid,why text,keys jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if why is null or why not in ('partial_binding','conflicting_binding','mapping_miss') or keys is null or jsonb_typeof(keys)<>'array' or jsonb_array_length(keys)>32
  or exists(select from jsonb_array_elements(keys) x where jsonb_typeof(x)<>'string' or length(x#>>'{}') not between 1 and 120 or x#>>'{}'~'[[:cntrl:]]')
  or not exists(select from svitlo_vps.catalog where id=address and kind='address') then raise exception 'invalid binding review';end if;
 insert into svitlo_catalog.binding_reviews(address_id,reason,evidence) values(address,why,jsonb_build_object('lineKeys',keys))
 on conflict(address_id,reason) do update set evidence=excluded.evidence,last_seen_at=clock_timestamp(),observations=svitlo_catalog.binding_reviews.observations+1,
  state=case when svitlo_catalog.binding_reviews.evidence is distinct from excluded.evidence then 'open' else svitlo_catalog.binding_reviews.state end;
end $$;
alter function svitlo_catalog.record_review(uuid,text,jsonb) owner to svitlo_catalog_owner;revoke all on function svitlo_catalog.record_review(uuid,text,jsonb) from public;
grant execute on function svitlo_catalog.record_review(uuid,text,jsonb) to svitlo_stage_api,svitlo_stage_worker;

-- One DB round-trip/transaction for a source-validated page. This does not make
-- the diagnostic collector an allocator and exposes no new public SQL endpoint.
create function svitlo_discovery.catalog_entries(rid text,settlement text,entity_kind text,parent uuid,entries jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;allocated_ids uuid[];begin
 if entries is null or jsonb_typeof(entries)<>'array' or jsonb_array_length(entries)>50
  or exists(select from jsonb_array_elements(entries) e where jsonb_typeof(e)<>'object' or jsonb_typeof(e->'id') is distinct from 'string' or jsonb_typeof(e->'name') is distinct from 'string'
   or e-'id'-'name'<>'{}'::jsonb) then raise exception 'invalid catalogue page';end if;
 -- Separate SPI statements: the projection must see rows allocated by the
 -- preceding statement, rather than the outer SELECT's earlier snapshot.
 select array_agg(svitlo_discovery.catalog_entry(rid,settlement,entity_kind,parent,x->>'id',x->>'name') order by n)
 into allocated_ids from jsonb_array_elements(entries) with ordinality v(x,n);
 with rows as(
  select array_position(allocated_ids,e.id) n,e.*,s.label as street,s.metadata as street_metadata,c.label as city,c.id as city_id,c.metadata as city_metadata
  from svitlo_vps.catalog e left join svitlo_vps.catalog s on s.id=e.parent_id left join svitlo_vps.catalog c on c.id=s.parent_id
  where e.id=any(allocated_ids) and e.redirect_to is null and svitlo_vps.catalog_allowed(e.id)
 ) select coalesce(jsonb_agg(to_jsonb(rows)-'n' order by n),'[]'::jsonb) into result from rows;
 return result;
end $$;
revoke all on function svitlo_discovery.catalog_entries(text,text,text,uuid,jsonb) from public;
grant execute on function svitlo_discovery.catalog_entries(text,text,text,uuid,jsonb) to svitlo_stage_api;
