-- ARC-06 SOURCE project only. Disabled on install. Never included in VPS
-- migration enumeration. Browser/PostgREST roles cannot access this schema.
create schema svitlo_migration_source;
revoke all on schema svitlo_migration_source from public,anon,authenticated,service_role;
create table svitlo_migration_source.control(id boolean primary key check(id),enabled boolean not null default false);
insert into svitlo_migration_source.control values(true,false);
create table svitlo_migration_source.fences(
 nonce uuid primary key,subject uuid not null,target_subject uuid not null,source_revision text not null,digest text not null,
 state text not null check(state in ('frozen','committed','aborted')),receipt_hash text,
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp()
);
create unique index migration_source_one_writer on svitlo_migration_source.fences(subject) where state in ('frozen','committed');
alter table svitlo_migration_source.control enable row level security;
alter table svitlo_migration_source.fences enable row level security;

create function svitlo_migration_source.assert_session(subject uuid,session_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if subject is null or session_id is null or not exists(select from auth.sessions s where s.id=session_id and s.user_id=subject and (s.not_after is null or s.not_after>clock_timestamp())) then raise insufficient_privilege using message='source session no longer active';end if;
end $$;
create function svitlo_migration_source.guard_profiles() returns trigger language plpgsql security definer set search_path='' as $$
declare owner_subject uuid;subjects uuid[];begin
 if tg_op='UPDATE' and new.owner is not distinct from old.owner and new.address is not distinct from old.address and new.name is not distinct from old.name and new.preferences is not distinct from old.preferences then return new;end if;
 subjects:=case tg_op when 'INSERT' then array[new.owner] when 'DELETE' then array[old.owner] else array[old.owner,new.owner] end;
 for owner_subject in select distinct unnest(subjects) s order by s loop
  perform pg_advisory_xact_lock(hashtextextended('migration-source-profiles:'||owner_subject::text,0));
  if exists(select from svitlo_migration_source.fences f where f.subject=owner_subject and f.state in ('frozen','committed')) then raise exception 'source_profile_writer_fenced' using errcode='55000';end if;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger migration_source_profile_writer before insert or delete or update of owner,address,name,preferences on public.svitlo_profiles for each row execute function svitlo_migration_source.guard_profiles();

create function svitlo_migration_source.export_profiles(subject uuid,session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb;begin
 perform svitlo_migration_source.assert_session(subject,session_id);
 if not (select enabled from svitlo_migration_source.control where id) then raise exception 'source_migration_disabled' using errcode='55000';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'address',jsonb_strip_nulls(jsonb_build_object('department',p.address->'department','cityId',p.address->'cityId','streetId',p.address->'streetId','house',p.address->'house','city',p.address->'city','street',p.address->'street')),'preferences',coalesce((select jsonb_object_agg(key,value) from jsonb_each(p.preferences) where key in ('schedule','publication','change','emergency','reminder','restoration','lead')),'{}'::jsonb)) order by p.id),'[]'::jsonb)
 into items from (select id,name,address,preferences from public.svitlo_profiles where owner=subject order by id limit 11) p;
 if jsonb_array_length(items)>10 or octet_length(items::text)>48000 then raise exception 'source_export_over_bound' using errcode='54000';end if;
 return jsonb_build_object('revision',encode(sha256(convert_to(items::text,'UTF8')),'hex'),'profiles',items);
end $$;
create function svitlo_migration_source.freeze(subject uuid,session_id uuid,request_nonce uuid,target uuid,revision text,fingerprint text) returns jsonb language plpgsql security definer set search_path='' as $$
declare prior svitlo_migration_source.fences;data jsonb;begin
 perform svitlo_migration_source.assert_session(subject,session_id);
 if request_nonce is null or target is null or revision!~'^[a-f0-9]{64}$' or fingerprint!~'^[a-f0-9]{64}$' then raise exception 'invalid_source_fence';end if;
 perform pg_advisory_xact_lock(hashtextextended('migration-source-profiles:'||subject::text,0));
 select * into prior from svitlo_migration_source.fences where nonce=request_nonce for update;
 if found then
  if prior.subject<>subject or prior.target_subject<>target or prior.source_revision<>revision or prior.digest<>fingerprint or prior.state='aborted' then raise exception 'source_fence_conflict' using errcode='55000';end if;
 else
  data:=svitlo_migration_source.export_profiles(subject,session_id);
  if data->>'revision' is distinct from revision then raise exception 'source_changed' using errcode='55000';end if;
  insert into svitlo_migration_source.fences(nonce,subject,target_subject,source_revision,digest,state) values(request_nonce,subject,target,revision,fingerprint,'frozen');
 end if;
 return jsonb_build_object('fenced',true,'nonce',request_nonce,'sourceSubject',subject,'targetSubject',target,'revision',revision,'digest',fingerprint);
end $$;
create function svitlo_migration_source.finish(subject uuid,session_id uuid,request_nonce uuid,fingerprint text,outcome text,receipt text default null,expected_target uuid default null) returns boolean language plpgsql security definer set search_path='' as $$
declare prior svitlo_migration_source.fences;begin
 perform svitlo_migration_source.assert_session(subject,session_id);
 perform pg_advisory_xact_lock(hashtextextended('migration-source-profiles:'||subject::text,0));
 select * into prior from svitlo_migration_source.fences f where f.nonce=request_nonce and f.subject=finish.subject and f.digest=fingerprint for update;
 if not found then
  -- The authenticated, signed cancellation may arrive before a delayed freeze.
  -- Reserve the nonce under the same subject lock so it can never freeze later.
  if outcome='aborted' and expected_target is not null and fingerprint~'^[a-f0-9]{64}$' then
   insert into svitlo_migration_source.fences(nonce,subject,target_subject,source_revision,digest,state)
   values(request_nonce,subject,expected_target,'',fingerprint,'aborted') on conflict(nonce) do nothing;
   return found;
  end if;
  return false;
 end if;
 if outcome not in ('committed','aborted') or (outcome='aborted' and prior.target_subject is distinct from expected_target) then return false;end if;
 if outcome='committed' and (receipt is null or receipt!~'^[a-f0-9]{64}$') then return false;end if;
 if prior.state=outcome then return prior.receipt_hash is not distinct from receipt;end if;
 if prior.state<>'frozen' then return false;end if;
 update svitlo_migration_source.fences set state=outcome,receipt_hash=receipt,updated_at=clock_timestamp() where nonce=request_nonce;return true;
end $$;
revoke all on all tables in schema svitlo_migration_source from public,anon,authenticated,service_role;
revoke execute on all functions in schema svitlo_migration_source from public,anon,authenticated,service_role;
