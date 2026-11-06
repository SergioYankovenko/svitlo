-- PWA-LIVE-45 r6. Append-only; profiles and existing bindings retain their IDs.
-- At most 10 canonical homes x the existing 32-line universal contract.
drop index public.svitlo_profiles_exact_address;
create unique index svitlo_profiles_exact_address on public.svitlo_profiles
 (owner,(address->>'department'),(address->>'cityId'),(address->>'streetId'),(address->>'house')) where address->>'canonicalAddressId' is null;
create unique index svitlo_profiles_canonical_line on public.svitlo_profiles
 (owner,(address->>'canonicalAddressId'),(coalesce(address->>'lineId',''))) where address->>'canonicalAddressId' is not null;

create or replace function public.svitlo_profiles_read(subject uuid,profile_id uuid default null) returns setof public.svitlo_profiles
 language sql stable set search_path='' as $$
 select (public.svitlo_hydrate(p)).* from public.svitlo_profiles p where p.owner=subject and (profile_id is null or p.id=profile_id)
 order by p.created_at,case when p.address->>'lineNumber' ~ '^[1-9][0-9]{0,2}$' then (p.address->>'lineNumber')::integer else 0 end,p.id
$$;

create function public.svitlo_address_group(a jsonb) returns text language sql immutable set search_path='' as $$
 select case when a->>'canonicalAddressId' is not null then 'canonical:'||(a->>'canonicalAddressId')
 else jsonb_build_array(a->>'department',a->>'cityId',a->>'streetId',a->>'house')::text end
$$;
revoke all on function public.svitlo_address_group(jsonb) from public;
grant execute on function public.svitlo_address_group(jsonb) to svitlo_stage_api,svitlo_sensor_owner;

create function svitlo_sensors.address_limit(subject uuid) returns integer
 language plpgsql security definer set search_path='' as $$
begin
 if subject is distinct from auth.uid() or subject is null then raise exception 'owner mismatch';end if;
 return case when exists(select 1 from svitlo_sensors.main_app_subscriptions g where g.subject=address_limit.subject and revoked_at is null and valid_from<=clock_timestamp() and valid_until>clock_timestamp()) then 10 else 2 end;
end $$;
alter function svitlo_sensors.address_limit(uuid) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.address_limit(uuid) from public;
grant execute on function svitlo_sensors.address_limit(uuid) to svitlo_stage_api;

create function public.svitlo_profile_quota_allows(subject uuid,a jsonb) returns boolean
 language plpgsql security invoker set search_path='' as $$
begin
 if subject is distinct from auth.uid() or subject is null then raise exception 'owner mismatch';end if;
 return (select count(*)<320 and (bool_or(public.svitlo_address_group(address)=public.svitlo_address_group(a))
  or count(distinct public.svitlo_address_group(address))<svitlo_sensors.address_limit(subject)) from public.svitlo_profiles where owner=subject);
end $$;
revoke all on function public.svitlo_profile_quota_allows(uuid,jsonb) from public;
grant execute on function public.svitlo_profile_quota_allows(uuid,jsonb) to svitlo_stage_api,svitlo_sensor_owner;

create function public.svitlo_address_quota(subject uuid) returns jsonb
 language plpgsql security invoker set search_path='' as $$
begin
 if subject is distinct from auth.uid() or subject is null then raise exception 'owner mismatch';end if;
 return (select jsonb_build_object('used',count(distinct public.svitlo_address_group(address)),'limit',svitlo_sensors.address_limit(subject)) from public.svitlo_profiles where owner=subject);
end $$;
revoke all on function public.svitlo_address_quota(uuid) from public;
grant execute on function public.svitlo_address_quota(uuid) to svitlo_stage_api;

create function svitlo_sensors.profile_has_sensor(pid uuid) returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.svitlo_profiles p join svitlo_sensors.reader_links l on l.profile_id=p.id where p.id=pid and p.owner=auth.uid())
$$;
alter function svitlo_sensors.profile_has_sensor(uuid) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.profile_has_sensor(uuid) from public;
grant execute on function svitlo_sensors.profile_has_sensor(uuid) to svitlo_stage_api;

create or replace function public.svitlo_profile_create_universal(subject uuid,profile_id uuid,address_data jsonb,display_name text,preference_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.svitlo_profiles;begin
 if subject is distinct from auth.uid() then raise exception 'owner mismatch';end if;
 if not exists(select 1 from svitlo_vps.catalog where id=(address_data->>'canonicalAddressId')::uuid and kind='address') then raise exception 'unknown canonical address';end if;
 if address_data->>'lineId' is not null and not exists(select 1 from svitlo_vps.address_lines where id=(address_data->>'lineId')::uuid and address_id=(address_data->>'canonicalAddressId')::uuid and active) then raise exception 'line mismatch';end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-profile-owner:'||subject::text,0));
 select * into p from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=address_data->>'canonicalAddressId'
  and coalesce(address->>'lineId','')=coalesce(address_data->>'lineId','') for update;
 if found then return jsonb_build_object('created',false,'profile',to_jsonb(public.svitlo_hydrate(p)));end if;
 -- Adopt the original unresolved profile only if no sensor is attached to it.
 select * into p from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=address_data->>'canonicalAddressId' and address->>'lineId' is null for update;
 if found and address_data->>'lineId' is not null then
  if svitlo_sensors.profile_has_sensor(p.id) then return jsonb_build_object('status','bound_unresolved');end if;
  update public.svitlo_profiles set address=address||address_data where id=p.id returning * into p;
  return jsonb_build_object('created',false,'profile',to_jsonb(public.svitlo_hydrate(p)));
 end if;
 if not public.svitlo_profile_quota_allows(subject,address_data) then return jsonb_build_object('status','limit');end if;
 insert into public.svitlo_profiles(id,owner,address,name,preferences) values(profile_id,subject,address_data,left(coalesce(display_name,''),60),preference_data) returning * into p;
 return jsonb_build_object('created',true,'profile',to_jsonb(p));
end $$;

create function public.svitlo_profile_group_create(subject uuid,addresses jsonb,display_name text,preference_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a jsonb;first_address jsonb;item jsonb;items jsonb:='[]';saved_profile public.svitlo_profiles;ordinal integer;largest integer;created boolean:=false;line_count integer;begin
 if subject is distinct from auth.uid() or subject is null then raise exception 'owner mismatch';end if;
 if jsonb_typeof(addresses) is distinct from 'array' or jsonb_array_length(addresses) not between 2 and 32 then raise exception 'invalid line set';end if;
 first_address:=addresses->0;line_count:=jsonb_array_length(addresses);
 if (select count(distinct value->>'lineId') from jsonb_array_elements(addresses))<>line_count then raise exception 'duplicate line';end if;
 for a in select value from jsonb_array_elements(addresses) loop
  if a->>'canonicalAddressId' is distinct from first_address->>'canonicalAddressId' or not exists(select 1 from svitlo_vps.address_lines l join svitlo_vps.catalog c on c.id=l.address_id where l.id=(a->>'lineId')::uuid and l.address_id=(a->>'canonicalAddressId')::uuid and l.active and c.operator_id=a->>'operatorId') then raise exception 'line mismatch';end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-profile-owner:'||subject::text,0));
 perform 1 from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=first_address->>'canonicalAddressId' for update;
 if not exists(select 1 from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=first_address->>'canonicalAddressId') and not public.svitlo_profile_quota_allows(subject,first_address) then return jsonb_build_object('status','limit');end if;
 if (select count(*) from public.svitlo_profiles where owner=subject)+(select count(*) from jsonb_array_elements(addresses) x where not exists(select 1 from public.svitlo_profiles p where p.owner=subject and p.address->>'canonicalAddressId'=x.value->>'canonicalAddressId' and p.address->>'lineId'=x.value->>'lineId'))>320 then return jsonb_build_object('status','limit');end if;
 if exists(select 1 from public.svitlo_profiles p where p.owner=subject and p.address->>'canonicalAddressId'=first_address->>'canonicalAddressId' and p.address->>'lineId' is null and svitlo_sensors.profile_has_sensor(p.id)) then return jsonb_build_object('status','bound_unresolved');end if;
 select coalesce(max((address->>'lineNumber')::integer),0) into largest from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=first_address->>'canonicalAddressId';
 for a in select value from jsonb_array_elements(addresses) loop
  select (address->>'lineNumber')::integer into ordinal from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=a->>'canonicalAddressId' and address->>'lineId'=a->>'lineId';
  if ordinal is null then largest:=largest+1;ordinal:=largest;end if;
  a:=a||jsonb_build_object('lineNumber',ordinal,'multipleLines',true);
  item:=public.svitlo_profile_create_universal(subject,gen_random_uuid(),a,display_name,
   case when ordinal=1 then preference_data else preference_data||'{"reminder":false,"restoration":false,"publication":false,"change":false,"schedule":false,"emergency":false}'::jsonb end);
  if item->>'status' is not null then raise exception 'line group creation failed';end if;
  saved_profile:=jsonb_populate_record(null::public.svitlo_profiles,item->'profile');
  update public.svitlo_profiles set address=address||jsonb_build_object('lineNumber',ordinal,'multipleLines',true) where id=saved_profile.id returning * into saved_profile;
  created:=created or (item->>'created')::boolean;
  items:=items||jsonb_build_array(to_jsonb(public.svitlo_hydrate(saved_profile)));
 end loop;
 return jsonb_build_object('created',created,'profiles',(select jsonb_agg(value order by (value->'address'->>'lineNumber')::integer) from jsonb_array_elements(items)));
end $$;
revoke all on function public.svitlo_profile_group_create(uuid,jsonb,text,jsonb) from public;
grant execute on function public.svitlo_profile_group_create(uuid,jsonb,text,jsonb) to svitlo_stage_api;

-- Change only the quota/list bounds in the existing reviewed command bodies.
-- The subscription, QR rotation, expiry and disconnect wrappers stay in place.
do $$
declare signature text;definition text;before text;begin
 foreach signature in array array['svitlo_sensors.phone_command_before_sub01(text,jsonb)','svitlo_sensors.command_before_sub01(text,jsonb)','svitlo_sensors.phone_relocate_before_sub01(jsonb)','svitlo_maps.allocate_address(text,text,jsonb)','public.svitlo_profile_create(uuid,uuid,jsonb,text,jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);before:=definition;
  if signature like 'svitlo_sensors.%' then
   definition:=replace(definition,'select * into profile from public.svitlo_profiles where id=(p->>''profileId'')::uuid and owner=actor;','select * into profile from public.svitlo_profiles where id=(p->>''profileId'')::uuid and owner=actor for update;');
  end if;
  if signature like 'svitlo_sensors.phone_command%' then
   definition:=replace(definition,')>=10 then return jsonb_build_object(''http'',409,''code'',''sensor_membership_limit'')',')>=320 then return jsonb_build_object(''http'',409,''code'',''sensor_membership_limit'')');
   definition:=replace(definition,'if (select count(*) from public.svitlo_profiles where owner=actor)>=10 then','if not public.svitlo_profile_quota_allows(actor,jsonb_build_object(''canonicalAddressId'',address_id)) then');
   definition:=replace(definition,'    if profile.id is null then
     if not public.svitlo_profile_quota_allows','    if profile.id is null then
     if exists(select 1 from public.svitlo_profiles sp where owner=actor and address->>''canonicalAddressId''=address_id::text and (address->>''lineId'')::uuid is not distinct from line_id) then return jsonb_build_object(''http'',409,''code'',''profile_already_has_sensor'');end if;
     if not public.svitlo_profile_quota_allows');
  elsif signature like 'svitlo_sensors.command%' then
   definition:=replace(definition,'order by sm.created_at limit 10','order by sm.created_at limit 320');
  elsif signature like 'svitlo_sensors.phone_relocate%' then
   null; -- The profile row lock above serializes relocation against adoption.
  elsif signature like 'svitlo_maps.%' then
   definition:=replace(definition,'(select count(*) from public.svitlo_profiles where owner=actor)>=10','not public.svitlo_profile_quota_allows(actor,jsonb_build_object(''canonicalAddressId'',aid))');
  else
   definition:=replace(definition,'if (select count(*) from public.svitlo_profiles where owner=subject)>=10 then','if not public.svitlo_profile_quota_allows(subject,address_data) then');
  end if;
  if definition=before then raise exception 'quota transform marker missing: %',signature;end if;
  execute definition;
 end loop;
end $$;
alter table svitlo_sensors.policy drop constraint policy_max_sensors_check;
alter table svitlo_sensors.policy add constraint policy_max_sensors_check check(max_sensors between 1 and 320);
update svitlo_sensors.policy set max_sensors=320 where id;
-- Existing profile uniqueness and reader_links.profile_id enforce one sensor per line.

create or replace function svitlo_sensors.main_app_entitlement() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();g svitlo_sensors.main_app_subscriptions;stamp timestamptz:=clock_timestamp();active boolean;begin
 if actor is null then return jsonb_build_object('http',401,'code','sensor_session_required');end if;
 select * into g from svitlo_sensors.main_app_subscriptions where subject=actor;
 active:=found and g.revoked_at is null and g.valid_from<=stamp and g.valid_until>stamp;
 return jsonb_build_object('http',200,'schemaVersion',1,'entitlement',jsonb_build_object('policy','main_app_subscription_v1','ownerQrTransferGate',true,'status',case when active then 'active' else 'inactive' end,'validUntil',case when active then g.valid_until else null end,'testAccess',active and g.source='private_test','maxAddresses',case when active then 10 else 2 end,'maxSensorsPerAddress',1,'maxLinesPerAddress',32,'maxSensorsPerLine',1,'addressCounting','canonical_home'));
end $$;
