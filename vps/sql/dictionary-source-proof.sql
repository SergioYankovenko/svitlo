-- Public cities/streets intentionally have operator_id=NULL. Authorize the
-- projection by their exact provider alias and route, not that nullable field.
-- The general catalogue predicate also authorizes private user_map profiles.
-- Public projection must not inherit that private-table dependency or payload.
create function svitlo_search.public_allowed(entity uuid) returns boolean language sql stable security definer set search_path='' as $$
 with recursive path as(
  select id,parent_id,metadata,operator_id,1 depth from svitlo_vps.catalog where id=entity
  union all select c.id,c.parent_id,c.metadata,c.operator_id,p.depth+1 from svitlo_vps.catalog c join path p on c.id=p.parent_id where p.depth<8
 ) select exists(select from path) and not exists(select from path p left join svitlo_vps.catalog_exclusions x on x.entity_id=p.id where x.entity_id is not null or p.metadata->>'catalogStatus'='service' or p.metadata->>'origin'='user_map' or p.operator_id='map-only')
$$;
alter function svitlo_search.public_allowed(uuid) owner to svitlo_search_owner;revoke all on function svitlo_search.public_allowed(uuid) from public;
create or replace function svitlo_search.document(entity uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select case when not svitlo_search.public_allowed(e.id) then jsonb_build_object('id',e.id,'kind',e.kind,'parentId','','label','','allowed',false)
 else jsonb_build_object('id',e.id,'kind',e.kind,'parentId',coalesce(e.parent_id::text,''),'label',e.label,
 'searchLabel',case when e.kind='city' and e.metadata->>'regionOperator' is not null then coalesce(e.source_ref->>'sourceName',e.label) else e.label end,
 'operatorId',coalesce(e.operator_id,e.metadata->>'regionOperator',p.operator_id,p.metadata->>'regionOperator',''),
 'aliases',coalesce((select jsonb_agg(a.label) from svitlo_catalog.name_aliases a where a.entity_id=e.id and a.reviewed and a.valid_from<=now() and (a.valid_until is null or a.valid_until>now())),'[]'::jsonb),
 'geoCodes',coalesce((select jsonb_agg(l.place_code) from svitlo_catalog.geography_links l where l.entity_id in(e.id,p.id,g.id) and l.valid_from<=now() and (l.valid_until is null or l.valid_until>now())),'[]'::jsonb),
 'district',case when e.metadata->>'districtVerified'='true' then e.metadata->>'district' end,
 'allowed',e.redirect_to is null
  and not exists(select from svitlo_vps.catalog x where x.id in(e.id,p.id,g.id) and x.metadata->>'regionOperator' is not null and x.metadata->>'sourceActive'='false')
  and (e.kind<>'city' or svitlo_vps.catalog_city_state(e.id)<>'empty')
  and (e.kind<>'street' or svitlo_vps.catalog_city_state(e.parent_id)<>'empty')) end
 from svitlo_vps.catalog e left join svitlo_vps.catalog p on p.id=e.parent_id left join svitlo_vps.catalog g on g.id=p.parent_id where e.id=entity
$$;
alter function svitlo_search.document(uuid) owner to svitlo_search_owner;revoke all on function svitlo_search.document(uuid) from public;
grant execute on function svitlo_search.document(uuid) to svitlo_stage_api,svitlo_stage_worker;
grant select on svitlo_vps.catalog_aliases to svitlo_search_owner;
create or replace function svitlo_search.dictionary_stage(scope_key text,route_key text,settlement text,entry_kind text,parent uuid,items jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare d svitlo_search.dictionaries;begin
 if scope_key!~'^[a-f0-9]{64}$' or entry_kind not in('street','house') or jsonb_typeof(items)<>'array' or jsonb_array_length(items)>25000 or octet_length(items::text)>4000000 then raise exception 'invalid dictionary projection';end if;
 if exists(select from jsonb_array_elements(items) x where jsonb_typeof(x)<>'object' or not x ?& array['id','name'] or x-array['id','name']<>'{}'::jsonb or jsonb_typeof(x->'id')<>'string' or jsonb_typeof(x->'name')<>'string' or length(x->>'id') not between 1 and 150 or length(x->>'name') not between 1 and 240) then raise exception 'invalid dictionary rows';end if;
 if not exists(select from svitlo_geo.routes r join svitlo_geo.route_places l on l.route_id=r.id join svitlo_vps.catalog c on c.id=parent
  join svitlo_vps.catalog_aliases a on a.entity_id=c.id and a.operator_id=r.operator_id and a.kind=c.kind
  where r.id=route_key and r.active and r.operator_id='ua-cherkasy' and l.settlement_code=settlement
   and c.kind=case when entry_kind='street' then 'city' else 'street' end
   and (a.provider_key::jsonb)->>0=r.branch_id and (a.provider_key::jsonb)->>1=r.provider_city_id)
 then raise exception 'invalid dictionary route';end if;
 perform pg_advisory_xact_lock(hashtextextended('dictionary-stage:'||scope_key,0));
 select * into d from svitlo_search.dictionaries where scope=scope_key for update;
 if found then
  if d.route_id<>route_key or d.settlement_code<>settlement or d.kind<>entry_kind or d.parent_id<>parent then raise exception 'dictionary scope conflict';end if;
  if d.lease_until>clock_timestamp() or d.ready_revision is distinct from d.revision and d.staged_at>now()-interval '10 minutes' then return false;end if;
  if d.rows=items and d.ready_revision=d.revision and d.expires_at>now() then return true;end if;
  if cardinality(d.obsolete)>=10 then return false;end if;
  update svitlo_search.dictionaries set rows=items,obsolete=array_append(obsolete,revision),revision=gen_random_uuid(),ready_revision=null,staged_at=clock_timestamp(),token=null,lease_until=null,next_at=clock_timestamp(),attempts=0 where scope=scope_key;
 else
  perform pg_advisory_xact_lock(311032032);
  if (select count(*) from svitlo_search.dictionaries)>=1000 or (select count(*) from svitlo_search.dictionaries where ready_revision is distinct from revision)>=100 then return false;end if;
  insert into svitlo_search.dictionaries(scope,route_id,settlement_code,kind,parent_id,rows) values(scope_key,route_key,settlement,entry_kind,parent,items);
 end if;return true;
end $$;
alter function svitlo_search.dictionary_stage(text,text,text,text,uuid,jsonb) owner to svitlo_search_owner;
revoke all on function svitlo_search.dictionary_stage(text,text,text,text,uuid,jsonb) from public;
grant execute on function svitlo_search.dictionary_stage(text,text,text,text,uuid,jsonb) to svitlo_stage_api;
