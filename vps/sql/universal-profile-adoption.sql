create or replace function public.svitlo_profile_create_universal(subject uuid,profile_id uuid,address_data jsonb,display_name text,preference_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.svitlo_profiles; begin
 if subject is distinct from auth.uid() then raise exception 'owner mismatch';end if;
 if not exists(select 1 from svitlo_vps.catalog where id=(address_data->>'canonicalAddressId')::uuid and kind='address') then raise exception 'unknown canonical address';end if;
 if address_data->>'lineId' is not null and not exists(select 1 from svitlo_vps.address_lines where id=(address_data->>'lineId')::uuid and address_id=(address_data->>'canonicalAddressId')::uuid and active) then raise exception 'line mismatch';end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-profile-owner:'||subject::text,0));
 select * into p from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=address_data->>'canonicalAddressId'
  and (coalesce(address->>'lineId','')=coalesce(address_data->>'lineId','') or address->>'lineId' is null) for update;
 if found then
  if p.address->>'lineId' is null and address_data->>'lineId' is not null then
   update public.svitlo_profiles set address=address||address_data where id=p.id returning * into p;
  end if;
  return jsonb_build_object('created',false,'profile',to_jsonb(public.svitlo_hydrate(p)));
 end if;
 if (select count(*) from public.svitlo_profiles where owner=subject)>=10 then return jsonb_build_object('status','limit');end if;
 insert into public.svitlo_profiles(id,owner,address,name,preferences) values(profile_id,subject,address_data,left(coalesce(display_name,''),60),preference_data) returning * into p;
 return jsonb_build_object('created',true,'profile',to_jsonb(p));
end $$;
