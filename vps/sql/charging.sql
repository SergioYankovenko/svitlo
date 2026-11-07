-- ARCH-MOD-01-16. Catalog, connector observations and exact power bindings are separate.
do $$ begin if not exists(select from pg_roles where rolname='svitlo_charging_owner') then create role svitlo_charging_owner nologin nosuperuser nobypassrls;end if;if exists(select from pg_roles where rolname='svitlo_charging_owner' and (rolsuper or rolbypassrls or rolcanlogin)) then raise exception 'unexpected module role privilege';end if;end $$;
create schema svitlo_charging authorization svitlo_charging_owner;
create table svitlo_charging.control(id boolean primary key check(id),enabled boolean not null default false);
insert into svitlo_charging.control values(true,false);
create table svitlo_charging.providers(id text primary key,reviewed boolean not null default false,license_text text not null,attribution_name text not null,license_url text not null);
insert into svitlo_charging.providers values('ocm',false,'CC BY 4.0','Open Charge Map','https://creativecommons.org/licenses/by/4.0/');
create table svitlo_charging.stations(id text primary key check(id~'^ocm:[1-9][0-9]{0,11}$'),provider text not null,provider_id text not null,label text not null,address text not null,latitude double precision not null check(latitude between 44 and 53),longitude double precision not null check(longitude between 22 and 41),connectors jsonb not null check(jsonb_array_length(connectors)<=32),attribution jsonb not null,catalog_updated_at timestamptz,collected_at timestamptz not null,reported_operational boolean,active boolean not null default true,unique(provider,provider_id));
create table svitlo_charging.observations(station_id text not null references svitlo_charging.stations(id),connector_id text not null,source_id text not null,state text not null check(state in ('online','offline','unknown')),observed_at timestamptz not null,received_at timestamptz not null default clock_timestamp(),valid_until timestamptz not null,primary key(station_id,connector_id,source_id),check(valid_until>observed_at and valid_until<=observed_at+interval '5 minutes'));
create table svitlo_charging.bindings(station_id text primary key references svitlo_charging.stations(id),address_id uuid not null references svitlo_vps.catalog(id),line_id uuid not null references svitlo_vps.address_lines(id),reviewed boolean not null default false,proof text not null check(length(proof) between 8 and 500),reviewed_by uuid not null,valid_from timestamptz not null,valid_until timestamptz not null,backup_power text not null check(backup_power in ('yes','no','unknown')),check(valid_until>valid_from));
create function svitlo_charging.capabilities() returns jsonb language sql stable security definer set search_path='' as $$ select jsonb_build_object('schemaVersion',1,'enabled',enabled and to_regprocedure('svitlo_charging.spatial_viewport(double precision,double precision,double precision,double precision)') is not null,'postgis',exists(select from pg_extension where extname='postgis'),'locationRequired',false,'liveConnectorData',false) from svitlo_charging.control where id $$;
create function svitlo_charging.binding(station text) returns jsonb language sql stable security definer set search_path='' as $$ select jsonb_build_object('reviewed',b.reviewed and l.active and l.address_id=b.address_id,'addressId',b.address_id,'lineId',b.line_id,'proof',b.proof,'validFrom',extract(epoch from b.valid_from)*1000,'validUntil',extract(epoch from b.valid_until)*1000,'backupPower',b.backup_power) from svitlo_charging.bindings b join svitlo_vps.address_lines l on l.id=b.line_id where b.station_id=station $$;
create function svitlo_charging.viewport(west double precision,south double precision,east double precision,north double precision) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 if not coalesce((svitlo_charging.capabilities()->>'enabled')::boolean,false) then raise exception 'charging disabled';end if;
 if west<22 or east>41 or south<44 or north>53 or west>=east or south>=north or (east-west)*(north-south)>4 then raise exception 'invalid viewport';end if;
 execute 'select svitlo_charging.spatial_viewport($1,$2,$3,$4)' into result using west,south,east,north;return result;
end $$;
create function svitlo_charging.import_catalog(items jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare x jsonb;count integer:=0;begin
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items)>200 then raise exception 'invalid charging batch';end if;
 for x in select * from jsonb_array_elements(items) loop
  if x->>'provider'<>'ocm' or not exists(select from svitlo_charging.providers p where p.id='ocm' and p.reviewed and p.license_text=x->'attribution'->>'license' and p.attribution_name=x->'attribution'->>'name' and p.license_url=x->'attribution'->>'licenseUrl') then raise exception 'charging license not reviewed';end if;
  -- A changed pin/address invalidates the prior electrical review. Distance to
  -- a nearby home cannot silently restore it.
  update svitlo_charging.bindings b set reviewed=false from svitlo_charging.stations s where s.id=x->>'id' and b.station_id=s.id and (s.latitude<>(x->>'latitude')::double precision or s.longitude<>(x->>'longitude')::double precision or s.address<>x->>'address');
  insert into svitlo_charging.stations(id,provider,provider_id,label,address,latitude,longitude,connectors,attribution,catalog_updated_at,collected_at,reported_operational)
  values(x->>'id',x->>'provider',x->>'providerId',x->>'label',x->>'address',(x->>'latitude')::double precision,(x->>'longitude')::double precision,x->'connectors',x->'attribution',to_timestamp((x->>'catalogUpdatedAt')::double precision/1000),to_timestamp((x->>'collectedAt')::double precision/1000),(x->>'reportedOperational')::boolean)
  on conflict(id) do update set label=excluded.label,address=excluded.address,latitude=excluded.latitude,longitude=excluded.longitude,connectors=excluded.connectors,attribution=excluded.attribution,catalog_updated_at=excluded.catalog_updated_at,collected_at=excluded.collected_at,reported_operational=excluded.reported_operational;
  count:=count+1;
 end loop;return count;
end $$;
grant usage on schema svitlo_vps to svitlo_charging_owner;grant select on svitlo_vps.address_lines to svitlo_charging_owner;
do $$ declare r record;begin
 for r in select tablename from pg_tables where schemaname='svitlo_charging' loop execute format('alter table svitlo_charging.%I owner to svitlo_charging_owner',r.tablename);end loop;
 for r in select p.oid::regprocedure f,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='svitlo_charging' loop execute format('alter function %s owner to svitlo_charging_owner',r.f);execute format('revoke all on function %s from public',r.f);if r.proname='import_catalog' then execute format('grant execute on function %s to svitlo_stage_worker',r.f);else execute format('grant execute on function %s to svitlo_stage_api',r.f);end if;end loop;
end $$;
grant usage on schema svitlo_charging to svitlo_stage_api,svitlo_stage_worker;
