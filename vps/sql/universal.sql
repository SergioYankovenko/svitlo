create table svitlo_vps.operators (
 id text primary key check(id ~ '^[a-z0-9][a-z0-9-]{1,63}$'), adapter_key text not null,
 label text not null, state text not null check(state in ('available','degraded','disabled')),
 is_test boolean not null default false, config jsonb not null default '{}', revision integer not null default 1
);
create table svitlo_vps.catalog (
 id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('city','street','address')),
 parent_id uuid references svitlo_vps.catalog(id), label text not null check(length(label) between 1 and 240),
 operator_id text references svitlo_vps.operators(id), source_ref jsonb not null default '{}',
 metadata jsonb not null default '{}', redirect_to uuid references svitlo_vps.catalog(id),
 check((kind='city' and parent_id is null) or (kind<>'city' and parent_id is not null)),
 check(kind<>'address' or operator_id is not null),check(redirect_to is distinct from id)
);
create index catalog_children on svitlo_vps.catalog(parent_id,kind,label collate "C",id);
create index catalog_cities on svitlo_vps.catalog(kind,label collate "C",id) where parent_id is null;
create table svitlo_vps.catalog_aliases (
 operator_id text not null references svitlo_vps.operators(id),kind text not null,
 provider_key text not null,entity_id uuid not null references svitlo_vps.catalog(id),
 primary key(operator_id,kind,provider_key)
);
create index catalog_alias_entity on svitlo_vps.catalog_aliases(entity_id);
create table svitlo_vps.address_lines (
 id uuid primary key default gen_random_uuid(), address_id uuid not null references svitlo_vps.catalog(id),
 source_key text not null,label text not null,group_code text,active boolean not null default true,
 evidence jsonb not null default '{}',unique(address_id,source_key)
);
create index lines_address on svitlo_vps.address_lines(address_id) where active;
create table svitlo_vps.address_resolutions (
 address_id uuid primary key references svitlo_vps.catalog(id),state text not null,
 complete boolean not null,checked_at bigint not null,evidence jsonb not null default '{}'
);
-- Importer only. Names/provider keys can change without allocating a new catalog ID.
create function svitlo_vps.catalog_upsert(op text,entity_kind text,provider_key text,display_label text,parent uuid,ref jsonb,meta jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare found_id uuid; begin
 perform pg_advisory_xact_lock(311032028);
 select a.entity_id into found_id from svitlo_vps.catalog_aliases a where a.operator_id=op and a.kind=entity_kind and a.provider_key=catalog_upsert.provider_key;
 if found_id is null then
  insert into svitlo_vps.catalog(kind,parent_id,label,operator_id,source_ref,metadata) values(entity_kind,parent,display_label,case when entity_kind='address' then op end,ref,meta) returning id into found_id;
  insert into svitlo_vps.catalog_aliases values(op,entity_kind,provider_key,found_id);
 else
  update svitlo_vps.catalog set label=display_label,source_ref=ref,metadata=meta where id=found_id and (label,source_ref,metadata) is distinct from (display_label,ref,meta);
 end if;return found_id;
end $$;
revoke all on function svitlo_vps.catalog_upsert(text,text,text,text,uuid,jsonb,jsonb) from public;
grant select on svitlo_vps.operators,svitlo_vps.catalog,svitlo_vps.catalog_aliases to svitlo_stage_api,svitlo_stage_worker;
grant select,insert,update on svitlo_vps.address_lines,svitlo_vps.address_resolutions to svitlo_stage_api,svitlo_stage_worker;
create function public.svitlo_profile_create_universal(subject uuid,profile_id uuid,address_data jsonb,display_name text,preference_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.svitlo_profiles; begin
 if subject is distinct from auth.uid() then raise exception 'owner mismatch';end if;
 if not exists(select 1 from svitlo_vps.catalog where id=(address_data->>'canonicalAddressId')::uuid and kind='address') then raise exception 'unknown canonical address';end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-profile-owner:'||subject::text,0));
 select * into p from public.svitlo_profiles where owner=subject and address->>'canonicalAddressId'=address_data->>'canonicalAddressId'
  and coalesce(address->>'lineId','')=coalesce(address_data->>'lineId','');
 if found then return jsonb_build_object('created',false,'profile',to_jsonb(public.svitlo_hydrate(p)));end if;
 if (select count(*) from public.svitlo_profiles where owner=subject)>=10 then return jsonb_build_object('status','limit');end if;
 insert into public.svitlo_profiles(id,owner,address,name,preferences) values(profile_id,subject,address_data,left(coalesce(display_name,''),60),preference_data) returning * into p;
 return jsonb_build_object('created',true,'profile',to_jsonb(p));
end $$;
revoke all on function public.svitlo_profile_create_universal(uuid,uuid,jsonb,text,jsonb) from public;
grant execute on function public.svitlo_profile_create_universal(uuid,uuid,jsonb,text,jsonb) to svitlo_stage_api;
