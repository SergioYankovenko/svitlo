-- ARCH-MOD-01-03: transactional catalogue change delivery. No personal payloads.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='svitlo_events_owner') then
  create role svitlo_events_owner nologin nobypassrls;
 end if;
end $$;
create schema svitlo_events authorization svitlo_events_owner;
revoke all on schema svitlo_events from public;
create table svitlo_events.jobs(
 id uuid primary key default gen_random_uuid(), version bigint generated always as identity unique,
 entity_id uuid not null, topic text not null default 'catalog.changed.v1' check(topic='catalog.changed.v1'),
 created_at timestamptz not null default clock_timestamp(), available_at timestamptz not null default clock_timestamp(),
 state text not null default 'ready' check(state in ('ready','running','done','dead')),
 attempts integer not null default 0 check(attempts between 0 and 5),
 token uuid, lease_until timestamptz, finished_at timestamptz, error_code text
);
create index modular_jobs_due on svitlo_events.jobs(available_at,version) where state in ('ready','running');
create index modular_jobs_retention on svitlo_events.jobs(finished_at) where state='done';
-- Durable projection inbox. A later Meilisearch writer must acknowledge its
-- exact version only after the engine's asynchronous task succeeds.
create table svitlo_events.catalog_dirty(entity_id uuid primary key,version bigint not null,changed_at timestamptz not null);
alter table svitlo_events.jobs owner to svitlo_events_owner;
alter table svitlo_events.catalog_dirty owner to svitlo_events_owner;
revoke all on all tables in schema svitlo_events from public,svitlo_stage_api,svitlo_stage_session,svitlo_stage_worker;

create function svitlo_events.catalog_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and
  (new.kind,new.parent_id,new.label,new.operator_id,new.redirect_to,
   new.metadata->'sourceActive',new.metadata->'catalogStatus',new.metadata->'district',new.metadata->'districtVerified',new.source_ref->'sourceName')
  is not distinct from
  (old.kind,old.parent_id,old.label,old.operator_id,old.redirect_to,
   old.metadata->'sourceActive',old.metadata->'catalogStatus',old.metadata->'district',old.metadata->'districtVerified',old.source_ref->'sourceName') then return new;end if;
 insert into svitlo_events.jobs(entity_id) values(case when tg_op='DELETE' then old.id else new.id end);
 return case when tg_op='DELETE' then old else new end;
end $$;
alter function svitlo_events.catalog_changed() owner to svitlo_events_owner;
revoke all on function svitlo_events.catalog_changed() from public;
create trigger modular_catalog_changed after insert or update or delete on svitlo_vps.catalog
 for each row execute function svitlo_events.catalog_changed();

create function svitlo_events.claim(batch_size integer default 20) returns setof svitlo_events.jobs
language plpgsql security definer set search_path='' as $$
begin
 if batch_size is null or batch_size not between 1 and 20 then raise exception 'invalid batch';end if;
 -- Final crashed attempt is visible in the dead queue, never silently stranded.
 update svitlo_events.jobs set state='dead',finished_at=clock_timestamp(),error_code='lease_expired',token=null,lease_until=null
 where id in(select id from svitlo_events.jobs where state='running' and lease_until<clock_timestamp() and attempts=5 limit 20 for update skip locked);
 return query with due as(
  select id from svitlo_events.jobs where attempts<5 and available_at<=clock_timestamp()
   and (state='ready' or state='running' and lease_until<clock_timestamp())
   order by available_at,version limit batch_size for update skip locked
 ) update svitlo_events.jobs j set state='running',attempts=j.attempts+1,token=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds'
 from due where j.id=due.id returning j.*;
end $$;

create function svitlo_events.complete(job_id uuid,proof uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare j svitlo_events.jobs;begin
 select * into j from svitlo_events.jobs where id=job_id and token=proof and state='running' for update;
 if not found or j.lease_until<=clock_timestamp() then return false;end if;
 insert into svitlo_events.catalog_dirty(entity_id,version,changed_at) values(j.entity_id,j.version,j.created_at)
 on conflict(entity_id) do update set version=excluded.version,changed_at=excluded.changed_at
 where svitlo_events.catalog_dirty.version<excluded.version;
 update svitlo_events.jobs set state='done',finished_at=clock_timestamp(),token=null,lease_until=null,error_code=null where id=job_id;
 return true;
end $$;

create function svitlo_events.fail(job_id uuid,proof uuid,reason text) returns boolean
language plpgsql security definer set search_path='' as $$
declare affected integer;j svitlo_events.jobs;begin
 select * into j from svitlo_events.jobs where id=job_id and token=proof and state='running' for update;
 if not found or j.lease_until<=clock_timestamp() then return false;end if;
 update svitlo_events.jobs set state=case when attempts=5 then 'dead' else 'ready' end,
  available_at=clock_timestamp()+make_interval(secs=>least(300,5*(2^(attempts-1))::integer)),
  finished_at=case when attempts=5 then clock_timestamp() end,token=null,lease_until=null,
  error_code=case when reason in ('projection_unavailable','invalid_event','worker_error') then reason else 'worker_error' end
 where id=job_id;
 get diagnostics affected=row_count;return affected=1;
end $$;

create function svitlo_events.cleanup() returns integer
language plpgsql security definer set search_path='' as $$
declare affected integer;begin
 delete from svitlo_events.jobs where id in(select id from svitlo_events.jobs where state='done' and finished_at<clock_timestamp()-interval '7 days' order by finished_at limit 1000 for update skip locked);
 get diagnostics affected=row_count;return affected;
end $$;

do $$ declare f text;begin
 foreach f in array array['claim(integer)','complete(uuid,uuid)','fail(uuid,uuid,text)','cleanup()'] loop
  execute 'alter function svitlo_events.'||f||' owner to svitlo_events_owner';
  execute 'revoke all on function svitlo_events.'||f||' from public';
  execute 'grant execute on function svitlo_events.'||f||' to svitlo_stage_worker';
 end loop;
end $$;
grant usage on schema svitlo_events to svitlo_stage_worker;
-- No backfill in DDL: existing catalogue indexing will use a separate bounded,
-- restartable reindex command. This migration adds no bulk work to release.
