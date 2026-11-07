-- Optional installation after the PostgreSQL image provides PostGIS. No nearest-
-- house or administrative-boundary electrical inference is performed.
create extension if not exists postgis;
alter table svitlo_charging.stations add column position public.geometry(Point,4326) generated always as (public.st_setsrid(public.st_makepoint(longitude,latitude),4326)) stored;
create index charging_viewport_gist on svitlo_charging.stations using gist(position) where active;
create function svitlo_charging.spatial_viewport(west double precision,south double precision,east double precision,north double precision) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('stations',coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.label,'address',s.address,'latitude',s.latitude,'longitude',s.longitude,'connectors',s.connectors,'attribution',s.attribution,'catalogUpdatedAt',s.catalog_updated_at,'collectedAt',s.collected_at,'reportedOperational',s.reported_operational,'liveState','unknown')),'[]'::jsonb),'limit',200,'status','catalog_only') from (
 select * from svitlo_charging.stations where active and position operator(public.&&) public.st_makeenvelope(west,south,east,north,4326) order by id limit 200) s
$$;
alter function svitlo_charging.spatial_viewport(double precision,double precision,double precision,double precision) owner to svitlo_charging_owner;
revoke all on function svitlo_charging.spatial_viewport(double precision,double precision,double precision,double precision) from public;
