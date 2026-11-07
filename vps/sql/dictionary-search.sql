-- Public provider dictionaries. A partition's source cache is expendable;
-- catalogue identities and electrical mappings are never inferred by Meili.
create table svitlo_search.dictionaries(
 scope text primary key check(scope~'^[a-f0-9]{64}$'),route_id text not null,settlement_code text not null,
 kind text not null check(kind in('street','house')),parent_id uuid not null references svitlo_vps.catalog(id),
 rows jsonb not null check(jsonb_typeof(rows)='array' and octet_length(rows::text)<=4000000),
 revision uuid not null default gen_random_uuid(),ready_revision uuid,obsolete uuid[] not null default '{}',expires_at timestamptz not null default now(),
 staged_at timestamptz not null default now(),token uuid,lease_until timestamptz,next_at timestamptz not null default now(),attempts integer not null default 0
);
alter table svitlo_search.dictionaries owner to svitlo_search_owner;
revoke all on svitlo_search.dictionaries from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session;
grant usage on schema svitlo_geo to svitlo_search_owner;
grant select on svitlo_geo.routes,svitlo_geo.route_places to svitlo_search_owner;
create index dictionaries_due on svitlo_search.dictionaries(next_at) where ready_revision is distinct from revision;
create function svitlo_search.dictionary_stage(scope_key text,route_key text,settlement text,entry_kind text,parent uuid,items jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare d svitlo_search.dictionaries;begin
 if scope_key!~'^[a-f0-9]{64}$' or entry_kind not in('street','house') or jsonb_typeof(items)<>'array' or jsonb_array_length(items)>25000 or octet_length(items::text)>4000000 then raise exception 'invalid dictionary projection';end if;
 if exists(select from jsonb_array_elements(items) x where jsonb_typeof(x)<>'object' or not x ?& array['id','name'] or x-array['id','name']<>'{}'::jsonb or jsonb_typeof(x->'id')<>'string' or jsonb_typeof(x->'name')<>'string' or length(x->>'id') not between 1 and 150 or length(x->>'name') not between 1 and 240) then raise exception 'invalid dictionary rows';end if;
 if not exists(select from svitlo_geo.routes r join svitlo_geo.route_places l on l.route_id=r.id join svitlo_vps.catalog c on c.id=parent where r.id=route_key and r.active and r.operator_id='ua-cherkasy' and l.settlement_code=settlement and c.kind=case when entry_kind='street' then 'city' else 'street' end and c.operator_id='ua-cherkasy') then raise exception 'invalid dictionary route';end if;
 perform pg_advisory_xact_lock(hashtextextended('dictionary-stage:'||scope_key,0));
 select * into d from svitlo_search.dictionaries where scope=scope_key for update;
 if found then
  if d.route_id<>route_key or d.settlement_code<>settlement or d.kind<>entry_kind or d.parent_id<>parent then raise exception 'dictionary scope conflict';end if;
  if d.lease_until>clock_timestamp() or d.ready_revision is distinct from d.revision and d.staged_at>now()-interval '10 minutes' then return false;end if;
  if d.rows=items and d.ready_revision=d.revision and d.expires_at>now() then return true;end if;
  if cardinality(d.obsolete)>=10 then return false;end if;
  update svitlo_search.dictionaries set rows=items,obsolete=array_append(obsolete,revision),revision=gen_random_uuid(),ready_revision=null,staged_at=clock_timestamp(),token=null,lease_until=null,next_at=clock_timestamp(),attempts=0 where scope=scope_key;
 else
  -- User-driven discovery cannot create an unbounded pending index queue.
  perform pg_advisory_xact_lock(311032032);
  if (select count(*) from svitlo_search.dictionaries)>=1000 or (select count(*) from svitlo_search.dictionaries where ready_revision is distinct from revision)>=100 then return false;end if;
  insert into svitlo_search.dictionaries(scope,route_id,settlement_code,kind,parent_id,rows) values(scope_key,route_key,settlement,entry_kind,parent,items);
 end if;return true;
end $$;
create function svitlo_search.dictionary_state(scope_key text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('revision',revision,'ready',coalesce(ready_revision=revision and expires_at>now(),false)) from svitlo_search.dictionaries where scope=scope_key
$$;
create function svitlo_search.dictionary_repair(scope_key text,version uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update svitlo_search.dictionaries set ready_revision=null,attempts=0,next_at=clock_timestamp() where scope=scope_key and revision=version and ready_revision=version and (lease_until is null or lease_until<=clock_timestamp());return found;
end $$;
create function svitlo_search.dictionary_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare d svitlo_search.dictionaries;begin
 select * into d from svitlo_search.dictionaries where ready_revision is distinct from revision and next_at<=clock_timestamp() and attempts<5 and (lease_until is null or lease_until<=clock_timestamp()) order by next_at limit 1 for update skip locked;
 if not found then return null;end if;
 update svitlo_search.dictionaries set token=gen_random_uuid(),lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1 where scope=d.scope returning * into d;
 return jsonb_build_object('scope',d.scope,'revision',d.revision,'token',d.token,'kind',d.kind,'rows',d.rows,'obsolete',to_jsonb(d.obsolete));
end $$;
create function svitlo_search.dictionary_finish(scope_key text,proof uuid,version uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update svitlo_search.dictionaries set ready_revision=version,obsolete='{}',expires_at=clock_timestamp()+interval '30 minutes',token=null,lease_until=null where scope=scope_key and token=proof and revision=version and lease_until>clock_timestamp();return found;
end $$;
create function svitlo_search.dictionary_fail(scope_key text,proof uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update svitlo_search.dictionaries set token=null,lease_until=null,next_at=clock_timestamp()+interval '30 seconds' where scope=scope_key and token=proof;return found;
end $$;
do $$ declare f text;begin
 foreach f in array array['dictionary_stage(text,text,text,text,uuid,jsonb)','dictionary_state(text)','dictionary_repair(text,uuid)','dictionary_claim()','dictionary_finish(text,uuid,uuid)','dictionary_fail(text,uuid)'] loop
  execute 'alter function svitlo_search.'||f||' owner to svitlo_search_owner';execute 'revoke all on function svitlo_search.'||f||' from public';
 end loop;
end $$;
grant execute on function svitlo_search.dictionary_stage(text,text,text,text,uuid,jsonb),svitlo_search.dictionary_state(text),svitlo_search.dictionary_repair(text,uuid) to svitlo_stage_api;
grant execute on function svitlo_search.dictionary_claim(),svitlo_search.dictionary_finish(text,uuid,uuid),svitlo_search.dictionary_fail(text,uuid) to svitlo_stage_worker;
