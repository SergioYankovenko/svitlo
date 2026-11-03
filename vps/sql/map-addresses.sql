-- Map-only addresses are private profile references, never provider evidence or queue assignments.
do $$ begin if not exists(select 1 from pg_roles where rolname='svitlo_map_owner') then create role svitlo_map_owner nologin nobypassrls;end if;end $$;
create schema svitlo_maps authorization svitlo_map_owner;
revoke all on schema svitlo_maps from public;
grant usage on schema svitlo_maps to svitlo_stage_api;
grant usage on schema auth,public,svitlo_vps to svitlo_map_owner;
grant execute on function auth.uid(),svitlo_vps.catalog_allowed(uuid),svitlo_vps.catalog_service_label(text,text) to svitlo_map_owner;
grant select,insert,update on svitlo_vps.catalog to svitlo_map_owner;
grant select,insert,update,delete on svitlo_vps.catalog_exclusions to svitlo_map_owner;
grant select on svitlo_vps.operators,svitlo_vps.address_lines,svitlo_vps.city_routes,public.svitlo_profiles to svitlo_map_owner;
create policy map_profile_owner on public.svitlo_profiles to svitlo_map_owner using(owner=auth.uid());
insert into svitlo_vps.operators(id,adapter_key,label,state,config) values('map-only','map-only','Адреса на карті · графік постачальника недоступний','degraded','{"privateMapReferences":true}') on conflict(id) do nothing;
create unique index catalog_map_key on svitlo_vps.catalog((metadata->>'mapKey')) where metadata->>'origin'='user_map';

create table svitlo_maps.budgets(bucket text primary key,window_start timestamptz not null,count integer not null check(count>=0));
alter table svitlo_maps.budgets owner to svitlo_map_owner;
alter table svitlo_maps.budgets enable row level security;
create function svitlo_maps.take_budget() returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();a integer;g integer;begin
 if actor is null then return false;end if;
 perform pg_advisory_xact_lock(311032244);
 delete from svitlo_maps.budgets where window_start<now()-interval '2 hours';
 select coalesce(sum(count),0) into a from svitlo_maps.budgets where bucket='owner:'||actor::text and window_start>now()-interval '1 minute';
 select coalesce(sum(count),0) into g from svitlo_maps.budgets where bucket='all' and window_start>now()-interval '1 minute';
 if a>=6 or g>=60 then return false;end if;
 insert into svitlo_maps.budgets values('owner:'||actor::text,date_trunc('minute',now()),1),('all',date_trunc('minute',now()),1)
 on conflict(bucket) do update set window_start=excluded.window_start,count=case when budgets.window_start=excluded.window_start then budgets.count+1 else 1 end;
 return true;
end $$;
alter function svitlo_maps.take_budget() owner to svitlo_map_owner;
revoke all on function svitlo_maps.take_budget() from public;
grant execute on function svitlo_maps.take_budget() to svitlo_stage_api;

create function svitlo_maps.allocate_address(street_key text,address_key text,address_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();city uuid;sid uuid;aid uuid;data jsonb;begin
 if actor is null or coalesce(street_key,'')!~'^[a-f0-9]{64}$' or coalesce(address_key,'')!~'^[a-f0-9]{64}$' or address_data->>'mapOnly' is distinct from 'true' or address_data->>'operatorId' is distinct from 'map-only'
  or address_data->>'lineId' is not null or length(coalesce(address_data->>'house','')) not between 1 and 80 or length(coalesce(address_data->>'street','')) not between 1 and 160
  or address_data->'mapLocation'->>'source' is distinct from 'visicom' or coalesce(address_data->'mapLocation'->>'precision','') not in ('house','street') then raise exception 'invalid map address';end if;
 city:=(address_data->>'cityId')::uuid;
 if not exists(select 1 from svitlo_vps.catalog where id=city and kind='city' and redirect_to is null and svitlo_vps.catalog_allowed(id)) then raise exception 'unknown city';end if;
 if svitlo_vps.catalog_service_label('street',address_data->>'street') then raise exception 'service street';end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-profile-owner:'||actor::text,0));
 perform pg_advisory_xact_lock(hashtextextended('map-street:'||street_key,0));
 perform pg_advisory_xact_lock(hashtextextended('map-address:'||address_key,0));
 select id into aid from svitlo_vps.catalog where metadata->>'origin'='user_map' and metadata->>'mapKey'='a:'||address_key;
 if not exists(select 1 from public.svitlo_profiles where owner=actor and address->>'canonicalAddressId'=aid::text) and (select count(*) from public.svitlo_profiles where owner=actor)>=10 then return '{"status":"limit"}';end if;
 select id into sid from svitlo_vps.catalog where metadata->>'origin'='user_map' and metadata->>'mapKey'='s:'||street_key;
 if sid is null then
  insert into svitlo_vps.catalog(kind,parent_id,label,operator_id,metadata) values('street',city,address_data->'mapLocation'->>'street','map-only',jsonb_build_object('origin','user_map','mapKey','s:'||street_key)) returning id into sid;
 end if;
 if aid is null then
  insert into svitlo_vps.catalog(kind,parent_id,label,operator_id,metadata) values('address',sid,address_data->>'house','map-only',jsonb_build_object('origin','user_map','mapKey','a:'||address_key)) returning id into aid;
 end if;
 data:=address_data||jsonb_build_object('canonicalAddressId',aid,'streetId',sid);
 return data;
end $$;
alter function svitlo_maps.allocate_address(text,text,jsonb) owner to svitlo_map_owner;
revoke all on function svitlo_maps.allocate_address(text,text,jsonb) from public;
grant execute on function svitlo_maps.allocate_address(text,text,jsonb) to svitlo_stage_api;
-- The caller's existing owner RLS and profile triggers perform the profile insert.
-- Both allocation and profile creation share this transaction and owner lock.
create function svitlo_maps.create_profile(street_key text,address_key text,address_data jsonb,display_name text,preference_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare data jsonb;begin
 data:=svitlo_maps.allocate_address(street_key,address_key,address_data);
 if data->>'status'='limit' then return data;end if;
 return public.svitlo_profile_create_universal(auth.uid(),gen_random_uuid(),data,left(coalesce(display_name,''),60),preference_data);
end $$;
alter function svitlo_maps.create_profile(text,text,jsonb,text,jsonb) owner to svitlo_map_owner;
revoke all on function svitlo_maps.create_profile(text,text,jsonb,text,jsonb) from public;
grant execute on function svitlo_maps.create_profile(text,text,jsonb,text,jsonb) to svitlo_stage_api;

create or replace function svitlo_vps.catalog_allowed(entity uuid) returns boolean language sql stable set search_path='' as $$
 with recursive path as (
  select id,parent_id,metadata,1 depth from svitlo_vps.catalog where id=entity
  union all select c.id,c.parent_id,c.metadata,p.depth+1 from svitlo_vps.catalog c join path p on c.id=p.parent_id where p.depth<8
 ) select exists(select 1 from path)
 and not exists(select 1 from path p left join svitlo_vps.catalog_exclusions x on x.entity_id=p.id where x.entity_id is not null or p.metadata->>'catalogStatus'='service')
 and (not exists(select 1 from path where metadata->>'origin'='user_map') or exists(select 1 from public.svitlo_profiles p where p.owner=auth.uid() and p.address->>'canonicalAddressId'=entity::text))
$$;
