-- ARCH-MOD-01-01/08/14. Bounded root-agent evidence, no arbitrary log/SQL viewer.
do $$ begin if not exists(select from pg_roles where rolname='svitlo_ops_owner') then create role svitlo_ops_owner nologin nosuperuser nobypassrls;end if;if exists(select from pg_roles where rolname='svitlo_ops_owner' and (rolsuper or rolbypassrls or rolcanlogin)) then raise exception 'unexpected module role privilege';end if;end $$;
create schema svitlo_ops authorization svitlo_ops_owner;
create table svitlo_ops.snapshots(id text primary key check(id in ('release','backup','disk','memory','database','wal','netdata','independent_monitor')),status text not null check(status in ('ok','degraded','failed','unknown','not_configured')),observed_at timestamptz not null,details jsonb not null check(jsonb_typeof(details)='object' and octet_length(details::text)<=4096));
create table svitlo_ops.logs(id bigint generated always as identity primary key,at timestamptz not null default clock_timestamp(),service text not null check(service in ('api','worker','discovery','admin')),event text not null check(event~'^[a-z_]{1,80}$'),status integer check(status between 100 and 599),duration_ms integer check(duration_ms between 0 and 300000));
create index ops_logs_at on svitlo_ops.logs(at);
alter table svitlo_ops.snapshots owner to svitlo_ops_owner;alter table svitlo_ops.logs owner to svitlo_ops_owner;
-- Only the root host agent (existing protected local owner connection) writes
-- these tables. Runtime API, worker and admin receive SELECT via a fixed facade.
grant usage on schema svitlo_ops,svitlo_search to svitlo_admin_owner;
grant select on svitlo_search.generations,svitlo_search.control,svitlo_search.work,svitlo_search.receipts to svitlo_admin_owner;
grant select on svitlo_ops.snapshots,svitlo_ops.logs to svitlo_admin_owner;
alter function svitlo_admin.list(text,text,integer,integer) rename to list_before_operations;
create function svitlo_admin.list(proof text,resource text,page_size integer default 25,page_offset integer default 0) returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;total bigint;begin
 if resource not in ('platform','logs','search') then return svitlo_admin.list_before_operations(proof,resource,page_size,page_offset);end if;
 if svitlo_admin.principal(proof) is null then raise insufficient_privilege using message='admin session required';end if;
 if page_size not between 1 and 100 or page_offset not between 0 and 100000 then raise exception 'invalid page';end if;
 if resource='platform' then
  select count(*) into total from svitlo_ops.snapshots;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select id,case when observed_at<clock_timestamp()-interval '3 minutes' then 'unknown' else status end status,observed_at,details from svitlo_ops.snapshots order by id limit page_size offset page_offset) x;
 elsif resource='search' then
  select count(*) into total from svitlo_search.generations;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select g.name id,g.state,g.created_at,g.activated_at,g.backfill_complete,g.last_error,(select count(*) from svitlo_search.receipts r where r.generation=g.name) indexed_rows,(select count(*) from svitlo_search.work) pending_changes,(select coalesce(extract(epoch from clock_timestamp()-min(changed_at)),0)::integer from svitlo_search.work) oldest_change_seconds from svitlo_search.generations g order by g.created_at desc limit page_size offset page_offset) x;
 else
  select count(*) into total from svitlo_ops.logs where at>clock_timestamp()-interval '2 days';
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from(select id,at,service,event,status,duration_ms from svitlo_ops.logs where at>clock_timestamp()-interval '2 days' order by id desc limit page_size offset page_offset) x;
 end if;return jsonb_build_object('data',rows,'total',total);
end $$;
alter function svitlo_admin.list(text,text,integer,integer) owner to svitlo_admin_owner;
revoke all on function svitlo_admin.list(text,text,integer,integer) from public;
grant execute on function svitlo_admin.list(text,text,integer,integer) to svitlo_stage_admin;
