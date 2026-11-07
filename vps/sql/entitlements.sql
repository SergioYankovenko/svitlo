-- Provider-independent rights. Existing private grants remain compatible.
do $$ begin if not exists(select from pg_roles where rolname='svitlo_entitlement_owner') then create role svitlo_entitlement_owner nologin nobypassrls;end if;end $$;
create schema svitlo_entitlements authorization svitlo_entitlement_owner;revoke all on schema svitlo_entitlements from public;
create table svitlo_entitlements.grants(
 reference uuid primary key,account_id uuid not null references auth.users on delete cascade,
 source text not null check(source in('google_play','manual')),revision bigint not null check(revision>0),
 active boolean not null,valid_until timestamptz not null,verified_until timestamptz,revoked_at timestamptz,test_access boolean not null default false,
 updated_at timestamptz not null default clock_timestamp()
);
alter table svitlo_entitlements.grants owner to svitlo_entitlement_owner;revoke all on svitlo_entitlements.grants from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session,svitlo_stage_admin;
create index entitlement_active_account on svitlo_entitlements.grants(account_id,valid_until) where active and revoked_at is null;
create table svitlo_entitlements.account_revisions(account_id uuid primary key references auth.users on delete cascade,revision bigint not null);
alter table svitlo_entitlements.account_revisions owner to svitlo_entitlement_owner;revoke all on svitlo_entitlements.account_revisions from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session,svitlo_stage_admin;
grant usage on schema auth,svitlo_sensors to svitlo_entitlement_owner;
grant execute on function auth.uid() to svitlo_entitlement_owner;
grant select(id) on auth.users to svitlo_entitlement_owner;
grant usage on schema svitlo_events to svitlo_entitlement_owner;
grant execute on function svitlo_events.publish(text,text,bigint,jsonb,timestamptz,integer) to svitlo_entitlement_owner;
create function svitlo_entitlements.changed() returns trigger language plpgsql security definer set search_path='' as $$
declare actor uuid;version bigint;begin
 if tg_table_schema='svitlo_sensors' then actor:=case when tg_op='DELETE' then old.subject else new.subject end;else actor:=case when tg_op='DELETE' then old.account_id else new.account_id end;end if;
 if not exists(select from auth.users where id=actor) then return null;end if;
 insert into svitlo_entitlements.account_revisions values(actor,1) on conflict(account_id) do update set revision=svitlo_entitlements.account_revisions.revision+1 returning revision into version;
 perform svitlo_events.publish('entitlement.changed.v1',actor::text,version,jsonb_build_object('accountId',actor,'entitlementRevision',version));return null;
end $$;
alter function svitlo_entitlements.changed() owner to svitlo_entitlement_owner;revoke all on function svitlo_entitlements.changed() from public;
create trigger entitlement_changed after insert or update or delete on svitlo_entitlements.grants for each row execute function svitlo_entitlements.changed();
create trigger entitlement_legacy_changed after insert or update or delete on svitlo_sensors.main_app_subscriptions for each row execute function svitlo_entitlements.changed();
grant select on svitlo_sensors.main_app_subscriptions to svitlo_entitlement_owner;
create policy entitlement_legacy_read on svitlo_sensors.main_app_subscriptions for select to svitlo_entitlement_owner using(true);
create function svitlo_entitlements.snapshot_for(actor uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare until_at timestamptz;testing boolean;unknown boolean;begin
 with candidates as(
  select valid_until,test_access,verified_until from svitlo_entitlements.grants where account_id=actor and active and revoked_at is null and valid_until>clock_timestamp()
  union all select valid_until,source='private_test',null from svitlo_sensors.main_app_subscriptions where subject=actor and valid_from<=clock_timestamp() and valid_until>clock_timestamp() and revoked_at is null
 ) select max(valid_until) filter(where verified_until is null or verified_until>clock_timestamp()),bool_and(test_access) filter(where verified_until is null or verified_until>clock_timestamp()),coalesce(bool_or(verified_until<=clock_timestamp()),false) into until_at,testing,unknown from candidates;
 return jsonb_build_object('policy','main_app_subscription_v1','ownerQrTransferGate',true,'status',case when until_at is not null then 'active' when unknown then 'unknown' else 'inactive' end,
  'validUntil',until_at,'testAccess',coalesce(testing,false),'maxAddresses',case when until_at is not null then 10 else 2 end,'maxSensorsPerAddress',1,'maxSensorsPerLine',1,'maxLinesPerAddress',32,'addressCounting','canonical_home','revision',coalesce((select revision from svitlo_entitlements.account_revisions where account_id=actor),0));
end $$;
create function svitlo_entitlements.current() returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 if auth.uid() is null then return '{"http":401,"code":"sensor_session_required"}';end if;
 return jsonb_build_object('http',200,'schemaVersion',1,'entitlement',svitlo_entitlements.snapshot_for(auth.uid()));
end $$;
create function svitlo_entitlements.apply_play(reference_id uuid,subject uuid,version bigint,is_active boolean,expires timestamptz,verified timestamptz,testing boolean) returns boolean language plpgsql security definer set search_path='' as $$
declare old svitlo_entitlements.grants;begin
 if reference_id is null or subject is null or version is null or version<=0 or is_active is null or expires is null or verified is null or verified>clock_timestamp()+interval '25 hours' or testing is null then raise exception 'invalid verified entitlement';end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-sub01:'||subject::text,0));
 perform pg_advisory_xact_lock(hashtextextended('entitlement:'||reference_id::text,0));
 select * into old from svitlo_entitlements.grants where reference=reference_id for update;
 if found then
  if old.account_id<>subject or old.source<>'google_play' then raise exception 'entitlement owner immutable';end if;
  if version<=old.revision then return false;end if;
 end if;
 insert into svitlo_entitlements.grants(reference,account_id,source,revision,active,valid_until,verified_until,test_access)
 values(reference_id,subject,'google_play',version,is_active,expires,verified,testing)
 on conflict(reference) do update set revision=excluded.revision,active=excluded.active,valid_until=excluded.valid_until,verified_until=excluded.verified_until,test_access=excluded.test_access,updated_at=clock_timestamp();return true;
end $$;
create function svitlo_entitlements.manual_grant(reference_id uuid,subject uuid,expires timestamptz) returns void language plpgsql security definer set search_path='' as $$begin
 if reference_id is null or subject is null or expires is null or expires<=clock_timestamp() or expires>clock_timestamp()+interval '30 days' then raise exception 'invalid manual entitlement';end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-sub01:'||subject::text,0));
 insert into svitlo_entitlements.grants(reference,account_id,source,revision,active,valid_until,test_access) values(reference_id,subject,'manual',1,true,expires,true);
end $$;
create function svitlo_entitlements.manual_revoke(reference_id uuid) returns boolean language plpgsql security definer set search_path='' as $$declare subject uuid;begin
 select account_id into subject from svitlo_entitlements.grants where reference=reference_id and source='manual';if not found then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-sub01:'||subject::text,0));
 update svitlo_entitlements.grants set active=false,revoked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where reference=reference_id and source='manual' and revoked_at is null;return found;
end $$;
do $$ declare f text;begin foreach f in array array['snapshot_for(uuid)','current()','apply_play(uuid,uuid,bigint,boolean,timestamptz,timestamptz,boolean)','manual_grant(uuid,uuid,timestamptz)','manual_revoke(uuid)'] loop execute 'alter function svitlo_entitlements.'||f||' owner to svitlo_entitlement_owner';execute 'revoke all on function svitlo_entitlements.'||f||' from public';end loop;end $$;
grant usage on schema svitlo_entitlements to svitlo_stage_api,svitlo_sensor_owner,svitlo_admin_owner,svitlo_identity_owner;
grant execute on function svitlo_entitlements.current() to svitlo_stage_api;
grant execute on function svitlo_entitlements.snapshot_for(uuid) to svitlo_sensor_owner;
grant execute on function svitlo_entitlements.manual_grant(uuid,uuid,timestamptz),svitlo_entitlements.manual_revoke(uuid) to svitlo_admin_owner;
grant select on svitlo_entitlements.grants to svitlo_admin_owner;
create or replace function svitlo_sensors.main_app_entitlement() returns jsonb language plpgsql security definer set search_path='' as $$
declare value jsonb;begin
 if auth.uid() is null then return '{"http":401,"code":"sensor_session_required"}';end if;
 value:=svitlo_entitlements.snapshot_for(auth.uid());if value->>'status'='unknown' then return '{"http":503,"code":"subscription_check_unavailable"}';end if;
 return jsonb_build_object('http',200,'schemaVersion',1,'entitlement',value);
end $$;
alter function svitlo_sensors.main_app_entitlement() owner to svitlo_sensor_owner;
create or replace function svitlo_sensors.address_limit(subject uuid) returns integer language plpgsql stable security definer set search_path='' as $$begin
 if subject is distinct from auth.uid() then raise insufficient_privilege using message='owner required';end if;
 return (svitlo_entitlements.snapshot_for(subject)->>'maxAddresses')::integer;
end $$;
alter function svitlo_sensors.address_limit(uuid) owner to svitlo_sensor_owner;
create or replace function svitlo_sensors.require_main_app_subscription() returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();value jsonb;begin
 if actor is null then return '{"http":401,"code":"sensor_session_required"}';end if;
 perform pg_advisory_xact_lock(311032106);perform pg_advisory_xact_lock_shared(hashtextextended('svitlo-sub01:'||actor::text,0));
 value:=svitlo_sensors.main_app_entitlement();if (value->>'http')::int=503 then return value;end if;
 if value->'entitlement'->>'status' is distinct from 'active' then return '{"http":403,"code":"subscription_required"}';end if;return null;
end $$;
alter function svitlo_sensors.require_main_app_subscription() owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.main_app_entitlement(),svitlo_sensors.address_limit(uuid),svitlo_sensors.require_main_app_subscription() from public;
grant execute on function svitlo_sensors.main_app_entitlement(),svitlo_sensors.address_limit(uuid) to svitlo_stage_api;
