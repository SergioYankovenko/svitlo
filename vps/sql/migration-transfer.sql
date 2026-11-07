-- ARCH-MOD-01-15. Target half of dual-proof transfer. No source writes here.
create role svitlo_migration_owner nologin nosuperuser nobypassrls;
create schema svitlo_migration authorization svitlo_migration_owner;
create table svitlo_migration.control(id boolean primary key check(id),enabled boolean not null default false);
insert into svitlo_migration.control values(true,false);
create table svitlo_migration.cohort(subject uuid primary key references auth.users(id),enabled boolean not null default false);
create table svitlo_migration.transfers(nonce uuid primary key,source_subject uuid not null,target_subject uuid not null references auth.users(id),digest text not null,payload jsonb not null,expires_at timestamptz not null,receipt jsonb,created_at timestamptz not null default clock_timestamp());
create unique index migration_one_source on svitlo_migration.transfers(source_subject) where receipt is not null;
grant usage on schema public,auth to svitlo_migration_owner;
grant execute on function auth.uid() to svitlo_migration_owner;
create function svitlo_migration.create_profiles(addresses jsonb,display_name text,preferences jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or jsonb_typeof(addresses)<>'array' or jsonb_array_length(addresses) not between 1 and 32 then raise exception 'invalid transfer profile';end if;
 if jsonb_array_length(addresses)>1 then return public.svitlo_profile_group_create(auth.uid(),addresses,display_name,preferences);end if;
 return public.svitlo_profile_create_universal(auth.uid(),gen_random_uuid(),addresses->0,display_name,preferences);
end $$;
create function svitlo_migration.status() returns jsonb language sql stable security definer set search_path='' as $$ select jsonb_build_object('allowed',coalesce((select c.enabled and x.enabled from svitlo_migration.control c join svitlo_migration.cohort x on x.subject=auth.uid() where c.id),false)) $$;
create function svitlo_migration.prepare(nonce_id uuid,source_id uuid,fingerprint text,data jsonb,deadline timestamptz) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not (svitlo_migration.status()->>'allowed')::boolean or auth.uid() is null or deadline<=clock_timestamp() or deadline>clock_timestamp()+interval '15 minutes' or fingerprint!~'^[a-f0-9]{64}$' or data->>'targetSubject'<>auth.uid()::text or data->>'sourceSubject'<>source_id::text or data->>'nonce'<>nonce_id::text then raise exception 'invalid transfer';end if;
 insert into svitlo_migration.transfers(nonce,source_subject,target_subject,digest,payload,expires_at) values(nonce_id,source_id,auth.uid(),fingerprint,data,deadline);return true;
end $$;
create function svitlo_migration.receipt(nonce_id uuid,fingerprint text) returns jsonb language sql stable security definer set search_path='' as $$ select receipt from svitlo_migration.transfers where nonce=nonce_id and target_subject=auth.uid() and digest=fingerprint $$;
create function svitlo_migration.commit(nonce_id uuid,fingerprint text,source_fence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t svitlo_migration.transfers;p jsonb;saved jsonb;items jsonb:='[]';result jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('migration-target:'||auth.uid()::text,0));
 select * into t from svitlo_migration.transfers where nonce=nonce_id and target_subject=auth.uid() and digest=fingerprint for update;
 if not found then return '{"error":"transfer_not_found"}';end if;if t.receipt is not null then return t.receipt;end if;
 if t.expires_at<=clock_timestamp() or not (svitlo_migration.status()->>'allowed')::boolean or source_fence->>'fenced'<>'true' or source_fence->>'nonce'<>nonce_id::text or source_fence->>'revision'<>t.payload->>'sourceRevision' then return '{"error":"transfer_not_ready"}';end if;
 perform pg_advisory_xact_lock(hashtextextended('migration-source:'||t.source_subject::text,0));
 if exists(select from svitlo_migration.transfers where source_subject=t.source_subject and receipt is not null) then return '{"error":"source_already_transferred"}';end if;
 for p in select * from jsonb_array_elements(t.payload->'profiles') loop
  if p->>'status'<>'resolved' or jsonb_array_length(p->'addresses') not between 1 and 32 then raise exception 'unresolved transfer';end if;
  saved:=svitlo_migration.create_profiles(p->'addresses',p->>'name',p->'preferences');
  if saved->>'status' is not null then raise exception 'transfer quota or binding conflict';end if;
  items:=items||jsonb_build_array(jsonb_build_object('legacyId',p->>'legacyId','targetProfiles',coalesce(saved->'profiles',jsonb_build_array(saved->'profile'))));
 end loop;
 result:=jsonb_build_object('ok',true,'nonce',nonce_id,'profiles',items,'sensorOwnershipImported',false,'sourceProfilesWriter','target');
 update svitlo_migration.transfers set receipt=result where nonce=nonce_id;return result;
end $$;
do $$ declare r record;begin
 for r in select tablename from pg_tables where schemaname='svitlo_migration' loop execute format('alter table svitlo_migration.%I owner to svitlo_migration_owner',r.tablename);end loop;
 for r in select p.oid::regprocedure f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='svitlo_migration' loop execute format('alter function %s owner to svitlo_migration_owner',r.f);execute format('revoke all on function %s from public',r.f);execute format('grant execute on function %s to svitlo_stage_api',r.f);end loop;
end $$;
grant usage on schema svitlo_migration to svitlo_stage_api;

-- Reuse the reviewed owner-scoped invoker/trigger path; migration owner cannot
-- edit arbitrary public profiles, sensor ACLs, epochs or subscription rights.
alter function svitlo_migration.create_profiles(jsonb,text,jsonb) owner to svitlo_stage_api;
revoke all on function svitlo_migration.create_profiles(jsonb,text,jsonb) from public;
grant execute on function svitlo_migration.create_profiles(jsonb,text,jsonb) to svitlo_migration_owner;
