-- Plain PostgreSQL/VPS only. Additive operators and public catalog cache; no profile migration.
do $$ begin if not exists(select 1 from pg_roles where rolname='svitlo_region_owner') then create role svitlo_region_owner nologin nobypassrls;end if;end $$;
create schema svitlo_regions authorization svitlo_region_owner;
revoke all on schema svitlo_regions from public;
grant usage on schema svitlo_regions to svitlo_stage_api,svitlo_stage_worker;
grant usage on schema svitlo_vps to svitlo_region_owner;
grant select,insert,update on svitlo_vps.catalog,svitlo_vps.catalog_aliases,svitlo_vps.city_routes to svitlo_region_owner;
grant select,insert,update,delete on svitlo_vps.catalog_exclusions to svitlo_region_owner;
grant select on svitlo_vps.operators to svitlo_region_owner;
grant execute on function svitlo_vps.catalog_upsert(text,text,text,text,uuid,jsonb,jsonb),svitlo_vps.catalog_service_label(text,text),svitlo_vps.catalog_route_state(text,text,uuid,text,boolean,timestamptz,jsonb) to svitlo_region_owner;
insert into svitlo_vps.operators(id,adapter_key,label,state,config) values
 ('ua-kyiv-dtek','dtek-public-v1','ДТЕК Київські електромережі','available','{"region":"м. Київ","coverage":"Каталог ОСР; будинки за запитом","unitSupported":false}'),
 ('ua-kyiv-region-dtek','dtek-public-v1','ДТЕК Київські регіональні електромережі','available','{"region":"Київська область","coverage":"Каталог ДТЕК КРЕМ; будинки за запитом, інші ОСР не підтверджені","unitSupported":false}');
create table svitlo_regions.imports(operator text not null,kind text not null,parent_key text not null,checked_at bigint not null,primary key(operator,kind,parent_key));
alter table svitlo_regions.imports owner to svitlo_region_owner;
alter table svitlo_regions.imports enable row level security;
create function svitlo_regions.import_entries(op text,entity_kind text,parent uuid,labels jsonb,checked bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare parent_row svitlo_vps.catalog;name text;display_name text;city text;street text;region text;url text;key text;source_key text;eid uuid;n integer:=0;stamp bigint:=floor(extract(epoch from clock_timestamp())*1000);begin
 if op not in ('ua-kyiv-dtek','ua-kyiv-region-dtek') or entity_kind not in ('city','street','address') or jsonb_typeof(labels) is distinct from 'array' then raise exception 'invalid region import';end if;
 if jsonb_array_length(labels) not between 1 and 10000 or checked is null or checked<0 or checked>stamp+300000 then raise exception 'invalid region import';end if;
 if entity_kind='city' and session_user not in ('svitlo_stage_worker','svitlo_owner') then raise exception 'city importer required';end if;
 if entity_kind='city' and parent is not null or entity_kind<>'city' and parent is null then raise exception 'invalid parent';end if;
 if exists(select 1 from jsonb_array_elements(labels) v where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 240 or v#>>'{}' ~ '[[:cntrl:]]') then raise exception 'invalid region label';end if;
 if entity_kind='city' and op='ua-kyiv-dtek' and labels<>'["м. Київ"]'::jsonb then raise exception 'invalid Kyiv city';end if;
 if parent is not null then
  select * into parent_row from svitlo_vps.catalog where id=parent;
  if not found or parent_row.metadata->>'regionOperator' is distinct from op or parent_row.kind<>(case when entity_kind='street' then 'city' else 'street' end) then raise exception 'foreign region parent';end if;
 end if;
 key:=coalesce(parent::text,'root');perform pg_advisory_xact_lock(hashtextextended('dtek-catalog:'||op||entity_kind||key,0));
 if exists(select 1 from svitlo_regions.imports i where i.operator=op and i.kind=entity_kind and i.parent_key=key and i.checked_at>=checked) then return '{"status":"cached","count":0}';end if;
 region:=case when op='ua-kyiv-dtek' then 'м. Київ' else 'Київська область' end;
 url:=case when op='ua-kyiv-dtek' then 'https://www.dtek-kem.com.ua/ua/shutdowns' else 'https://www.dtek-krem.com.ua/ua/shutdowns' end;
 update svitlo_vps.catalog e set metadata=e.metadata||'{"sourceActive":false}'::jsonb where e.kind=entity_kind and e.parent_id is not distinct from parent and e.metadata->>'regionOperator'=op and not (labels ? coalesce(e.source_ref->>'sourceName',e.label));
 for name in select distinct jsonb_array_elements_text(labels) loop
  if entity_kind='street' and (regexp_replace(lower(name),'[[:space:]]','','g') in ('безвулиці','невизначена','вул.невизначена')) then continue;end if;
  city:=case when entity_kind='city' then name else parent_row.source_ref->>'city' end;
  street:=case when entity_kind='street' then name else parent_row.source_ref->>'street' end;
  display_name:=case when entity_kind='city' and op='ua-kyiv-region-dtek' then name||' · Київська область' else name end;
  source_key:=jsonb_build_array(entity_kind,city,street,case when entity_kind='address' then name end)::text;
  eid:=svitlo_vps.catalog_upsert(op,entity_kind,source_key,display_name,parent,
   jsonb_strip_nulls(jsonb_build_object('city',city,'street',street,'house',case when entity_kind='address' then name end,'sourceName',name)),
   jsonb_build_object('regionOperator',op,'region',region,'sourceActive',true,'sourceURL',url,'sourceCheckedAt',checked));
  if entity_kind='city' then perform svitlo_vps.catalog_route_state(op,source_key,eid,'available',false,to_timestamp(checked/1000.0),jsonb_build_object('reference',url,'kind','street_index','houseCoverage','on_demand'));end if;
  n:=n+1;
 end loop;
 insert into svitlo_regions.imports values(op,entity_kind,key,checked) on conflict(operator,kind,parent_key) do update set checked_at=excluded.checked_at;
 return jsonb_build_object('status','imported','count',n);
end $$;
alter function svitlo_regions.import_entries(text,text,uuid,jsonb,bigint) owner to svitlo_region_owner;
revoke all on function svitlo_regions.import_entries(text,text,uuid,jsonb,bigint) from public;
grant execute on function svitlo_regions.import_entries(text,text,uuid,jsonb,bigint) to svitlo_stage_api,svitlo_stage_worker;

create table svitlo_regions.provider_state(operator text primary key check(operator in ('ua-kyiv-dtek','ua-kyiv-region-dtek','yasno-kyiv')),next_at bigint not null default 0,lease_until bigint not null default 0,ticket uuid,cooldown_until bigint not null default 0,last_code text,window_at bigint not null default 0,requests integer not null default 0);
alter table svitlo_regions.provider_state owner to svitlo_region_owner;
alter table svitlo_regions.provider_state enable row level security;
create function svitlo_regions.acquire(op text) returns jsonb language plpgsql security definer set search_path='' as $$
declare quota svitlo_regions.provider_state;stamp bigint:=floor(extract(epoch from clock_timestamp())*1000);proof uuid;begin
 if op not in ('ua-kyiv-dtek','ua-kyiv-region-dtek','yasno-kyiv') then raise exception 'invalid operator budget';end if;
 insert into svitlo_regions.provider_state(operator) values(op) on conflict do nothing;
 select * into quota from svitlo_regions.provider_state where operator=op for update;
 if quota.cooldown_until>stamp then return jsonb_build_object('granted',false,'reason','cooldown','code',coalesce(quota.last_code,'rate_limited'),'waitMs',quota.cooldown_until-stamp);end if;
 if quota.lease_until>stamp or quota.next_at>stamp then return jsonb_build_object('granted',false,'reason','busy','waitMs',greatest(50,least(500,greatest(quota.lease_until,quota.next_at)-stamp)));end if;
 if stamp>=quota.window_at+60000 then quota.window_at:=stamp;quota.requests:=0;end if;
 if quota.requests>=30 then return jsonb_build_object('granted',false,'reason','cooldown','code','rate_limited','waitMs',quota.window_at+60000-stamp);end if;
 proof:=gen_random_uuid();update svitlo_regions.provider_state set ticket=proof,lease_until=stamp+12000,next_at=stamp+1000,window_at=quota.window_at,requests=quota.requests+1 where operator=op;
 return jsonb_build_object('granted',true,'ticket',proof);
end $$;
alter function svitlo_regions.acquire(text) owner to svitlo_region_owner;
create function svitlo_regions.finish(op text,proof uuid,status integer,error_code text,retry_ms integer) returns void language sql security definer set search_path='' as $$
 update svitlo_regions.provider_state set ticket=null,lease_until=0,last_code=case when status=403 or error_code='forbidden' then 'forbidden' when status=429 then 'rate_limited' else left(error_code,80) end,
 cooldown_until=floor(extract(epoch from clock_timestamp())*1000)+case when status=403 or error_code='forbidden' then 1800000 when status=429 then greatest(60000,least(900000,coalesce(retry_ms,0))) when status>=500 or error_code is not null then 15000 else 0 end
 where operator=op and ticket=proof
$$;
alter function svitlo_regions.finish(text,uuid,integer,text,integer) owner to svitlo_region_owner;
revoke all on function svitlo_regions.acquire(text),svitlo_regions.finish(text,uuid,integer,text,integer) from public;
grant execute on function svitlo_regions.acquire(text),svitlo_regions.finish(text,uuid,integer,text,integer) to svitlo_stage_api,svitlo_stage_worker;
