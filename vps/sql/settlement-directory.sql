-- GEO-01 / BE-01 r2. Separate public administrative/routing reference data.
-- Existing catalogue, profile, subscription, sensor and history tables are untouched.
create schema svitlo_geo;
revoke all on schema svitlo_geo from public;
grant usage on schema svitlo_geo to svitlo_stage_api,svitlo_stage_worker;
create table svitlo_geo.editions(
 version text primary key,edition_date date not null,source_url text not null,
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 bundle_sha256 text not null check(bundle_sha256 ~ '^[a-f0-9]{64}$'),
 node_count integer not null check(node_count>0),settlement_count integer not null check(settlement_count>0),
 route_count integer not null check(route_count>=0),link_count integer not null check(link_count>=0),
 imported_at timestamptz not null default now(),active boolean not null default false
);
create unique index geo_single_active_edition on svitlo_geo.editions(active) where active;
create table svitlo_geo.places(
 code text primary key check(code ~ '^UA[0-9]{17}$'),
 parent_code text references svitlo_geo.places(code) deferrable initially deferred,
 level smallint not null check(level between 1 and 5),
 category text not null check(category in ('O','P','H','M','C','X','B','K')),
 name text not null check(length(name) between 1 and 240),search_name text not null,
 region_code text not null references svitlo_geo.places(code) deferrable initially deferred,
 district_code text references svitlo_geo.places(code) deferrable initially deferred,
 community_code text references svitlo_geo.places(code) deferrable initially deferred,
 settlement_code text references svitlo_geo.places(code) deferrable initially deferred,
 version text not null references svitlo_geo.editions(version),active boolean not null default true,
 check((level=1)=(parent_code is null))
);
create index geo_place_parent on svitlo_geo.places(parent_code,search_name,code);
create index geo_place_search on svitlo_geo.places(search_name text_pattern_ops) where active;
create index geo_place_region on svitlo_geo.places(region_code,level,search_name,code) where active;
create index geo_place_district on svitlo_geo.places(district_code) where active;
create index geo_place_community on svitlo_geo.places(community_code) where active;
create index geo_place_settlement on svitlo_geo.places(settlement_code) where active;
create index geo_place_version on svitlo_geo.places(version);
create table svitlo_geo.aliases(
 code text not null references svitlo_geo.places(code),alias text not null,search_name text not null,
 source_url text not null,reason text not null,version text not null references svitlo_geo.editions(version),
 primary key(code,search_name)
);
create index geo_alias_search on svitlo_geo.aliases(search_name text_pattern_ops);
create index geo_alias_version on svitlo_geo.aliases(version);
create table svitlo_geo.routes(
 id text primary key check(length(id) between 1 and 350),
 operator_id text not null references svitlo_vps.operators(id),branch_id text,branch_name text,
 provider_city_id text not null,provider_city_name text not null,
 region_code text not null references svitlo_geo.places(code),
 source_observed_at timestamptz not null,source_url text not null,
 legacy_catalog_city_id uuid references svitlo_vps.catalog(id),source_ref jsonb not null,
 evidence jsonb not null,version text not null references svitlo_geo.editions(version),active boolean not null default true
);
create index geo_route_region on svitlo_geo.routes(region_code,operator_id) where active;
create index geo_route_operator on svitlo_geo.routes(operator_id);
create index geo_route_legacy_city on svitlo_geo.routes(legacy_catalog_city_id);
create index geo_route_version on svitlo_geo.routes(version);
create table svitlo_geo.route_places(
 route_id text not null references svitlo_geo.routes(id),settlement_code text not null references svitlo_geo.places(code),
 match_state text not null check(match_state in ('reviewed','candidate')),
 match_method text not null check(match_method in ('reviewed_existing_identity','unique_name_type_region','ambiguous_name_type_region')),
 candidate_count integer not null check(candidate_count>0),primary key(route_id,settlement_code)
);
create index geo_routes_for_settlement on svitlo_geo.route_places(settlement_code,route_id);
do $$ declare t text;begin
 foreach t in array array['editions','places','aliases','routes','route_places'] loop
  execute format('alter table svitlo_geo.%I enable row level security',t);
  execute format('revoke all on svitlo_geo.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);
  execute format('grant select on svitlo_geo.%I to svitlo_stage_api,svitlo_stage_worker',t);
  execute format('create policy public_reference_read on svitlo_geo.%I for select to svitlo_stage_api,svitlo_stage_worker using(true)',t);
 end loop;
end $$;
