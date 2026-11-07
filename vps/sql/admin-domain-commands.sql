-- Explicit owning-module commands; no generic table writes from the console.
grant usage on schema svitlo_vps,svitlo_catalog to svitlo_admin_owner;
grant select(id,kind) on svitlo_vps.catalog to svitlo_admin_owner;
grant select,insert on svitlo_catalog.name_aliases to svitlo_admin_owner;
grant update(reviewed) on svitlo_catalog.name_aliases to svitlo_admin_owner;
grant update(state) on svitlo_catalog.binding_reviews to svitlo_admin_owner;
alter function svitlo_admin.command(text,uuid,text,text,text,jsonb) rename to command_before_domains;
revoke all on function svitlo_admin.command_before_domains(text,uuid,text,text,text,jsonb) from public,svitlo_stage_admin;
create function svitlo_admin.command(proof text,request uuid,command_kind text,command_target text,why text,data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb;actor_id uuid;prior svitlo_admin.commands;result jsonb;packet jsonb;reference uuid;begin
 if command_kind not in('entitlement.grant','entitlement.revoke_manual','catalog.alias_add','catalog.alias_revoke','catalog.review_dismiss','catalog.review_reopen') then return svitlo_admin.command_before_domains(proof,request,command_kind,command_target,why,data);end if;
 perform 1 from svitlo_admin.sessions s join svitlo_admin.principals a on a.id=s.principal_id where s.token_hash=proof and s.expires_at>clock_timestamp() and not a.disabled for share of s,a;
 p:=svitlo_admin.principal(proof);if p is null then raise insufficient_privilege using message='admin session required';end if;actor_id:=(p->>'id')::uuid;
 if request is null or why is null or length(why) not between 8 and 500 or command_target is null or length(command_target)>200 or data is null or jsonb_typeof(data)<>'object' or octet_length(data::text)>2000 then raise exception 'invalid admin command';end if;
 if command_kind like 'entitlement.%' then if not(p->'roles' ?| array['owner','billing-admin']) then raise insufficient_privilege using message='billing role required';end if;
 elsif not(p->'roles' ?| array['owner','operator']) then raise insufficient_privilege using message='operator role required';end if;
 packet:=jsonb_build_object('kind',command_kind,'target',command_target,'reason',why,'data',data);
 perform pg_advisory_xact_lock(hashtextextended('admin-command:'||request::text,0));select * into prior from svitlo_admin.commands where request_id=request;
 if found then if prior.actor<>actor_id or prior.packet<>packet then raise exception 'admin request conflict';end if;return prior.result;end if;
 if command_kind='entitlement.grant' then
  if data-array['until']<>'{}' or jsonb_typeof(data->'until') is distinct from 'string' then raise exception 'grant expiry required';end if;
  perform svitlo_entitlements.manual_grant(request,command_target::uuid,(data->>'until')::timestamptz);reference:=request;
 elsif command_kind='entitlement.revoke_manual' then
  if data<>'{}' then raise exception 'unexpected command fields';end if;
  if not svitlo_entitlements.manual_revoke(command_target::uuid) then raise exception 'manual grant not active';end if;
 elsif command_kind='catalog.alias_add' then
  if data-array['label','sourceReference','validFrom']<>'{}' or not data ?& array['label','sourceReference','validFrom'] or jsonb_typeof(data->'label')<>'string' or jsonb_typeof(data->'sourceReference')<>'string' or jsonb_typeof(data->'validFrom')<>'string' or not exists(select from svitlo_vps.catalog where id=command_target::uuid and kind in('city','street')) then raise exception 'invalid public name alias';end if;
  if (data->>'validFrom')::timestamptz>clock_timestamp()+interval '1 year' then raise exception 'invalid alias validity';end if;
  insert into svitlo_catalog.name_aliases(entity_id,label,source_reference,valid_from,reviewed) values(command_target::uuid,data->>'label',data->>'sourceReference',(data->>'validFrom')::timestamptz,true) on conflict(entity_id,label,source_reference) do nothing returning id into reference;
 elsif command_kind='catalog.alias_revoke' then
  if data<>'{}' then raise exception 'unexpected command fields';end if;update svitlo_catalog.name_aliases set reviewed=false where id=command_target::uuid and reviewed; if not found then raise exception 'reviewed alias missing';end if;
 else
  if data-array['reason']<>'{}' or data->>'reason' not in('partial_binding','conflicting_binding','mapping_miss') then raise exception 'review reason required';end if;
  update svitlo_catalog.binding_reviews set state=case when command_kind='catalog.review_dismiss' then 'dismissed' else 'open' end where address_id=command_target::uuid and reason=data->>'reason';if not found then raise exception 'review missing';end if;
 end if;
 result:=jsonb_build_object('id',request,'accepted',true)||case when reference is not null then jsonb_build_object('referenceId',reference) else '{}'::jsonb end;
 insert into svitlo_admin.commands(request_id,actor,kind,target,reason,packet,result) values(request,actor_id,command_kind,command_target,why,packet,result);return result;
end $$;
alter function svitlo_admin.command(text,uuid,text,text,text,jsonb) owner to svitlo_admin_owner;revoke all on function svitlo_admin.command(text,uuid,text,text,text,jsonb) from public;grant execute on function svitlo_admin.command(text,uuid,text,text,text,jsonb) to svitlo_stage_admin;
alter function svitlo_admin.list(text,text,integer,integer) rename to list_before_domains;
revoke all on function svitlo_admin.list_before_domains(text,text,integer,integer) from public,svitlo_stage_admin;
create function svitlo_admin.list(proof text,resource text,page_size integer,page_offset integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare p jsonb;rows jsonb;total bigint;begin
 if resource not in('subscriptions','aliases') then return svitlo_admin.list_before_domains(proof,resource,page_size,page_offset);end if;
 p:=svitlo_admin.principal(proof);if p is null then raise insufficient_privilege using message='admin session required';end if;
 if page_size is null or page_size not between 1 and 100 or page_offset is null or page_offset not between 0 and 10000 then raise exception 'invalid admin page';end if;
 if resource='subscriptions' then
  if not(p->'roles' ?| array['owner','support','billing-admin']) then raise insufficient_privilege using message='billing read role required';end if;
  with entries as(select reference::text id,account_id,source,active,valid_until,revoked_at,verified_until from svitlo_entitlements.grants union all select 'legacy:'||subject::text,subject,source,valid_from<=clock_timestamp() and revoked_at is null,valid_until,revoked_at,null from svitlo_sensors.main_app_subscriptions)
  select count(*) into total from entries;
  with entries as(select reference::text id,account_id,source,active,valid_until,revoked_at,verified_until from svitlo_entitlements.grants union all select 'legacy:'||subject::text,subject,source,valid_from<=clock_timestamp() and revoked_at is null,valid_until,revoked_at,null from svitlo_sensors.main_app_subscriptions)
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select * from entries order by id limit page_size offset page_offset) x;
 else
  select count(*) into total from svitlo_catalog.name_aliases;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select id,entity_id,label,source_reference,valid_from,valid_until,reviewed from svitlo_catalog.name_aliases order by id limit page_size offset page_offset) x;
 end if;return jsonb_build_object('data',rows,'total',total);
end $$;
alter function svitlo_admin.list(text,text,integer,integer) owner to svitlo_admin_owner;revoke all on function svitlo_admin.list(text,text,integer,integer) from public;grant execute on function svitlo_admin.list(text,text,integer,integer) to svitlo_stage_admin;
