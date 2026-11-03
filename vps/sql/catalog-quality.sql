-- Plan230. Non-destructive quarantine: raw catalog IDs/aliases remain for repair/history.
create table svitlo_vps.catalog_exclusions (
 entity_id uuid primary key references svitlo_vps.catalog(id) on delete cascade,
 reason text not null check(reason in ('service_placeholder','service_place','aggregate')),
 evidence jsonb not null, reviewed_at timestamptz not null default now()
);
create table svitlo_vps.city_routes (
 operator_id text not null references svitlo_vps.operators(id) on delete cascade,
 provider_key text not null, city_id uuid not null references svitlo_vps.catalog(id) on delete cascade,
 state text not null check(state in ('unknown','available','empty')),
 complete boolean not null default false, checked_at timestamptz not null,
 evidence jsonb not null, primary key(operator_id,provider_key),
 check(state<>'empty' or complete)
);
create index city_routes_city on svitlo_vps.city_routes(city_id,state);
grant select on svitlo_vps.catalog_exclusions,svitlo_vps.city_routes to svitlo_stage_api,svitlo_stage_worker;

create function svitlo_vps.catalog_service_label(kind text,label text) returns boolean
language sql immutable parallel safe set search_path='' as $$
 select case when kind='street' then regexp_replace(regexp_replace(lower(trim(label)),'^(вулиця|вул\.?)\s*','',''), '[[:space:]*' || chr(160) || ']+','','g') in ('невизначена')
 when kind='city' then regexp_replace(lower(label),'[[:space:]' || chr(160) || ']+','','g')='[невідомо]' else false end
$$;
create function svitlo_vps.catalog_classify() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if svitlo_vps.catalog_service_label(new.kind,new.label) then
  insert into svitlo_vps.catalog_exclusions(entity_id,reason,evidence) values(new.id,case when new.kind='street' then 'service_placeholder' else 'service_place' end,'{"policy":"exact-label-v1"}')
  on conflict(entity_id) do update set reason=excluded.reason,evidence=excluded.evidence;
 else
  delete from svitlo_vps.catalog_exclusions where entity_id=new.id and evidence->>'policy'='exact-label-v1';
 end if;
 return new;
end $$;
create trigger catalog_classify after insert or update of label,kind on svitlo_vps.catalog for each row execute function svitlo_vps.catalog_classify();
-- Trigger runs for existing rows once. Original labels and parent/alias rows are preserved.
update svitlo_vps.catalog set label=label;

create function svitlo_vps.catalog_allowed(entity uuid) returns boolean language sql stable set search_path='' as $$
 with recursive path as (
  select id,parent_id,metadata,1 depth from svitlo_vps.catalog where id=entity
  union all select c.id,c.parent_id,c.metadata,p.depth+1 from svitlo_vps.catalog c join path p on c.id=p.parent_id where p.depth<8
 ) select exists(select 1 from path) and not exists(select 1 from path p left join svitlo_vps.catalog_exclusions x on x.entity_id=p.id where x.entity_id is not null or p.metadata->>'catalogStatus'='service')
$$;
create function svitlo_vps.catalog_city_state(city uuid) returns text language sql stable set search_path='' as $$
 select case when exists(select 1 from svitlo_vps.city_routes where city_id=city and state='available') then 'available'
 when exists(select 1 from svitlo_vps.city_routes where city_id=city) and not exists(select 1 from svitlo_vps.city_routes where city_id=city and state<>'empty') then 'empty' else 'unknown' end
$$;
create function svitlo_vps.catalog_route_state(op text,key text,city uuid,new_state text,is_complete boolean,checked timestamptz,proof jsonb)
returns void language plpgsql security invoker set search_path='' as $$
begin
 key:=key::jsonb::text;
 if checked is null or proof is null or proof='{}'::jsonb or new_state not in ('unknown','available','empty') or (new_state='empty' and not is_complete) then raise exception 'Coverage requires explicit evidence; empty requires a complete verification';end if;
 if not exists(select 1 from svitlo_vps.catalog_aliases a join svitlo_vps.catalog c on c.id=a.entity_id where a.operator_id=op and a.kind='city' and a.provider_key=key and a.entity_id=city and c.kind='city') then raise exception 'Unknown city route';end if;
 insert into svitlo_vps.city_routes values(op,key,city,new_state,is_complete,checked,proof)
 on conflict(operator_id,provider_key) do update set city_id=excluded.city_id,state=excluded.state,complete=excluded.complete,checked_at=excluded.checked_at,evidence=excluded.evidence
 where (excluded.checked_at>=city_routes.checked_at or city_routes.state='unknown' and excluded.state='available') and (excluded.state<>'unknown' or city_routes.state='unknown');
end $$;
-- Only a reviewed administrative manifest can link routes. Never deduplicate by label.
create function svitlo_vps.catalog_link_city(op text,key text,target uuid,proof jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare old_id uuid;begin
 key:=key::jsonb::text;
 if proof is null or not(proof ? 'reference') or length(proof->>'reference')<8 then raise exception 'Verified mapping reference required';end if;
 perform pg_advisory_xact_lock(311032028);
 if not exists(select 1 from svitlo_vps.catalog where id=target and kind='city' and redirect_to is null) then raise exception 'Invalid canonical city';end if;
 select entity_id into old_id from svitlo_vps.catalog_aliases where operator_id=op and kind='city' and provider_key=key;
 if old_id is not null and old_id<>target then
  if exists(select 1 from svitlo_vps.catalog where id=old_id and kind<>'city') then raise exception 'Not a city alias';end if;
  update svitlo_vps.catalog set parent_id=target where parent_id=old_id;
  update svitlo_vps.catalog set redirect_to=target where id=old_id;
  update svitlo_vps.catalog_aliases set entity_id=target where kind='city' and entity_id=old_id;
  update svitlo_vps.city_routes set city_id=target where city_id=old_id;
 end if;
 insert into svitlo_vps.catalog_aliases values(op,'city',key,target) on conflict(operator_id,kind,provider_key) do update set entity_id=target;
 insert into svitlo_vps.city_routes values(op,key,target,'unknown',false,now(),proof) on conflict(operator_id,provider_key) do nothing;
end $$;
revoke all on function svitlo_vps.catalog_classify(),svitlo_vps.catalog_route_state(text,text,uuid,text,boolean,timestamptz,jsonb),svitlo_vps.catalog_link_city(text,text,uuid,jsonb) from public;
-- Pure lookup functions can only read the private catalog through existing runtime grants.
revoke all on function svitlo_vps.catalog_service_label(text,text),svitlo_vps.catalog_allowed(uuid),svitlo_vps.catalog_city_state(uuid) from public;
grant execute on function svitlo_vps.catalog_service_label(text,text),svitlo_vps.catalog_allowed(uuid),svitlo_vps.catalog_city_state(uuid) to svitlo_stage_api,svitlo_stage_worker;
