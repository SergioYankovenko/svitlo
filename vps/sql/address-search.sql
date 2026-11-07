-- ARCH-MOD-01-06. Derived public index with a PostgreSQL activation barrier.
do $$ begin if not exists(select from pg_roles where rolname='svitlo_search_owner') then create role svitlo_search_owner nologin nobypassrls;end if;end $$;
create schema svitlo_search authorization svitlo_search_owner;revoke all on schema svitlo_search from public;
grant usage on schema svitlo_vps,svitlo_catalog to svitlo_search_owner;
grant select on svitlo_vps.catalog,svitlo_vps.catalog_exclusions,svitlo_vps.city_routes,svitlo_catalog.name_aliases,svitlo_catalog.geography_links to svitlo_search_owner;
grant execute on function svitlo_vps.catalog_allowed(uuid),svitlo_vps.catalog_city_state(uuid) to svitlo_search_owner;
create table svitlo_search.generations(
 name text primary key check(name~'^svitlo_catalog_g_[a-z0-9]{8,32}$'),state text not null check(state in ('building','ready','active','standby','retired','failed')),
 checkpoint uuid,backfill_complete boolean not null default false,created_at timestamptz not null default clock_timestamp(),activated_at timestamptz,last_error text
);
create unique index search_single_active on svitlo_search.generations(state) where state='active';
create table svitlo_search.control(id boolean primary key default true check(id),enabled boolean not null default false,active_generation text references svitlo_search.generations(name));insert into svitlo_search.control(id) values(true);
create table svitlo_search.work(
 entity_id uuid primary key,kind text not null,token uuid not null default gen_random_uuid(),
 affected_parents uuid[] not null default '{}',cursor uuid,changed_at timestamptz not null default clock_timestamp()
);
create index search_work_age on svitlo_search.work(changed_at,entity_id);
create table svitlo_search.receipts(generation text not null references svitlo_search.generations(name),entity_id uuid not null,fingerprint text not null,indexed_at timestamptz not null default clock_timestamp(),primary key(generation,entity_id));
create table svitlo_search.scope_tokens(scope text primary key,token uuid not null default gen_random_uuid());
do $$ declare t text;begin foreach t in array array['generations','control','work','receipts','scope_tokens'] loop execute 'alter table svitlo_search.'||t||' owner to svitlo_search_owner';execute 'revoke all on svitlo_search.'||t||' from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session';end loop;end $$;
create function svitlo_search.search_key(value text) returns text language sql immutable parallel safe set search_path='' as $$select lower(normalize(btrim(value),NFC))$$;
create index catalog_exact_search on svitlo_vps.catalog(kind,parent_id,svitlo_search.search_key(label),id) where redirect_to is null;
create index catalog_alias_exact_search on svitlo_catalog.name_aliases(svitlo_search.search_key(label),entity_id) where reviewed;

create function svitlo_search.queue_root(entity uuid,entity_kind text,parents uuid[]) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock_shared(311032029);
 with scopes as(
  select 'city:' scope where entity_kind='city'
  union select 'street:'||entity::text where entity_kind='city'
  union select 'address:'||id::text from svitlo_vps.catalog where parent_id=entity and kind='street' and entity_kind='city'
  union select 'address:'||entity::text where entity_kind='street'
  union select case when entity_kind='street' then 'street:' else 'address:' end||x::text from unnest(parents) x where x is not null and entity_kind in ('street','address')
 ) insert into svitlo_search.scope_tokens(scope) select scope from scopes order by scope on conflict(scope) do update set token=gen_random_uuid();
 insert into svitlo_search.work(entity_id,kind,affected_parents) values(entity,entity_kind,array(select distinct x from unnest(parents) x where x is not null))
 on conflict(entity_id) do update set token=gen_random_uuid(),cursor=null,kind=excluded.kind,changed_at=clock_timestamp(),
 affected_parents=array(select distinct x from unnest(svitlo_search.work.affected_parents||excluded.affected_parents) x);
end $$;
create function svitlo_search.catalog_changed() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and
  (new.kind,new.parent_id,new.label,new.operator_id,new.redirect_to,new.metadata-'sourceCheckedAt',new.source_ref->'sourceName')
  is not distinct from
  (old.kind,old.parent_id,old.label,old.operator_id,old.redirect_to,old.metadata-'sourceCheckedAt',old.source_ref->'sourceName') then return new;end if;
 perform svitlo_search.queue_root(case when tg_op='DELETE' then old.id else new.id end,case when tg_op='DELETE' then old.kind else new.kind end,
  case when tg_op='INSERT' then array[new.parent_id] when tg_op='DELETE' then array[old.parent_id] else array[new.parent_id,old.parent_id] end);
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger search_catalog_changed after insert or update or delete on svitlo_vps.catalog for each row execute function svitlo_search.catalog_changed();
create function svitlo_search.reference_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare eid uuid;k text;p uuid;begin
 if tg_op='UPDATE' and tg_table_name='city_routes' then if (new.city_id,new.state,new.complete) is not distinct from (old.city_id,old.state,old.complete) then return new;end if;end if;
 if tg_op='UPDATE' and tg_table_name='catalog_exclusions' then if new.entity_id=old.entity_id then return new;end if;end if;
 if tg_table_name='city_routes' then eid:=case when tg_op='DELETE' then old.city_id else new.city_id end;
 else eid:=case when tg_op='DELETE' then old.entity_id else new.entity_id end;end if;
 select kind,parent_id into k,p from svitlo_vps.catalog where id=eid;
 if found then perform svitlo_search.queue_root(eid,k,array[p]);end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger search_exclusion_changed after insert or update or delete on svitlo_vps.catalog_exclusions for each row execute function svitlo_search.reference_changed();
create trigger search_route_changed after insert or update of state,complete or delete on svitlo_vps.city_routes for each row execute function svitlo_search.reference_changed();
create trigger search_alias_changed after insert or update or delete on svitlo_catalog.name_aliases for each row execute function svitlo_search.reference_changed();
create trigger search_geography_changed after insert or update or delete on svitlo_catalog.geography_links for each row execute function svitlo_search.reference_changed();

create function svitlo_search.document(entity uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',e.id,'kind',e.kind,'parentId',coalesce(e.parent_id::text,''),'label',e.label,
 'searchLabel',case when e.kind='city' and e.metadata->>'regionOperator' is not null then coalesce(e.source_ref->>'sourceName',e.label) else e.label end,
 'operatorId',coalesce(e.operator_id,e.metadata->>'regionOperator',p.operator_id,p.metadata->>'regionOperator',''),
 'aliases',coalesce((select jsonb_agg(a.label) from svitlo_catalog.name_aliases a where a.entity_id=e.id and a.reviewed and a.valid_from<=now() and (a.valid_until is null or a.valid_until>now())),'[]'::jsonb),
 'geoCodes',coalesce((select jsonb_agg(l.place_code) from svitlo_catalog.geography_links l where l.entity_id in(e.id,p.id,g.id) and l.valid_from<=now() and (l.valid_until is null or l.valid_until>now())),'[]'::jsonb),
 'district',case when e.metadata->>'districtVerified'='true' then e.metadata->>'district' end,
 'allowed',e.redirect_to is null and e.operator_id is distinct from 'map-only' and svitlo_vps.catalog_allowed(e.id)
  and not exists(select from svitlo_vps.catalog x where x.id in(e.id,p.id,g.id) and x.metadata->>'regionOperator' is not null and x.metadata->>'sourceActive'='false')
  and (e.kind<>'city' or svitlo_vps.catalog_city_state(e.id)<>'empty')
  and (e.kind<>'street' or svitlo_vps.catalog_city_state(e.parent_id)<>'empty'))
 from svitlo_vps.catalog e left join svitlo_vps.catalog p on p.id=e.parent_id left join svitlo_vps.catalog g on g.id=p.parent_id where e.id=entity;
$$;
create function svitlo_search.page(after_id uuid default null,root_id uuid default null,batch_size integer default 200,only_kind text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 if batch_size is null or batch_size not between 1 and 200 or only_kind is not null and only_kind not in ('city','street','address') then raise exception 'invalid index batch';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'document',svitlo_search.document(x.id)) order by x.id),'[]'::jsonb) into result
 from(select id from svitlo_vps.catalog where (after_id is null or id>after_id) and (only_kind is null or kind=only_kind) and
  (root_id is null or id=root_id or parent_id=root_id or parent_id in(select id from svitlo_vps.catalog where parent_id=root_id)) order by id limit batch_size) x;
 return result;
end $$;
create function svitlo_search.create_generation(generation text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(311032030);
 if exists(select from svitlo_search.generations where name=generation) then return;end if;
 if (select count(*) from svitlo_search.generations where state in ('active','standby','building','ready'))>=2 then raise exception 'generation capacity exceeded';end if;
 insert into svitlo_search.generations(name,state) values(generation,'building');
end $$;
create function svitlo_search.activate(generation text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 -- Every source/catalog/reference write takes the shared side before commit.
 -- A write waiting here publishes work against the new generation after switch.
 perform pg_advisory_xact_lock(311032030);perform pg_advisory_xact_lock(311032029);
 if not exists(select from svitlo_search.generations where name=generation and backfill_complete and state in ('ready','standby')) or exists(select from svitlo_search.work) then return false;end if;
 update svitlo_search.generations set state='standby' where state='active';
 update svitlo_search.generations set state='active',activated_at=clock_timestamp() where name=generation;
 update svitlo_search.control set active_generation=generation,enabled=true where id;return true;
end $$;
create function svitlo_search.scope_state(entity_kind text,parent uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('generation',c.active_generation,'ready',c.enabled and c.active_generation is not null and exists(select from svitlo_search.generations where name=c.active_generation and backfill_complete and state='active') and not exists(
  select from svitlo_search.work w where
   (entity_kind='city' and w.kind in ('city','global_city')) or w.entity_id=parent or parent=any(w.affected_parents)
   or w.entity_id=(select parent_id from svitlo_vps.catalog where id=parent)
 ),'enabled',c.enabled,'scopeToken',coalesce((select token::text from svitlo_search.scope_tokens where scope=entity_kind||':'||coalesce(parent::text,'')),'')) from svitlo_search.control c where id;
$$;
create function svitlo_search.request_repair(entity_kind text,parent uuid) returns void language plpgsql security definer set search_path='' as $$
declare k text;p uuid;begin
 if entity_kind='city' and parent is null then
  insert into svitlo_search.work(entity_id,kind) values('00000000-0000-0000-0000-000000000000','global_city') on conflict(entity_id) do nothing;return;
 end if;
 select kind,parent_id into k,p from svitlo_vps.catalog where id=parent;
 if not found or entity_kind='street' and k<>'city' or entity_kind='address' and k<>'street' or entity_kind not in ('street','address') then raise exception 'invalid repair scope';end if;
 if not exists(select from svitlo_search.work where entity_id=parent) then perform svitlo_search.queue_root(parent,k,array[p]);end if;
end $$;
-- Protected worker writes use this role's fixed tables and functions; no user
-- endpoint exposes generation administration, index credentials or arbitrary SQL.
do $$ declare f text;begin foreach f in array array['search_key(text)','queue_root(uuid,text,uuid[])','catalog_changed()','reference_changed()','document(uuid)','page(uuid,uuid,integer,text)','create_generation(text)','activate(text)','scope_state(text,uuid)','request_repair(text,uuid)'] loop
 execute 'alter function svitlo_search.'||f||' owner to svitlo_search_owner';execute 'revoke all on function svitlo_search.'||f||' from public';end loop;end $$;
grant usage on schema svitlo_search to svitlo_stage_api,svitlo_stage_worker;
grant execute on function svitlo_search.scope_state(text,uuid),svitlo_search.request_repair(text,uuid),svitlo_search.search_key(text),svitlo_search.document(uuid) to svitlo_stage_api;
grant execute on function svitlo_search.document(uuid),svitlo_search.page(uuid,uuid,integer,text),svitlo_search.create_generation(text),svitlo_search.activate(text) to svitlo_stage_worker;
grant select,insert,update,delete on svitlo_search.generations,svitlo_search.work,svitlo_search.receipts to svitlo_stage_worker;
grant select on svitlo_search.control to svitlo_stage_worker;
grant select on svitlo_search.scope_tokens to svitlo_stage_worker;
grant select on svitlo_catalog.name_aliases to svitlo_stage_api;
do $$ declare r record;begin for r in select distinct grantee from information_schema.table_privileges where ((table_schema='svitlo_vps' and table_name='catalog') or (table_schema='svitlo_catalog' and table_name='name_aliases')) and privilege_type in ('INSERT','UPDATE') and grantee<>'PUBLIC' loop
 execute format('grant usage on schema svitlo_search to %I',r.grantee);execute format('grant execute on function svitlo_search.search_key(text) to %I',r.grantee);end loop;end $$;
-- A rebuild, including the initial one, is bounded and restartable outside DDL.
