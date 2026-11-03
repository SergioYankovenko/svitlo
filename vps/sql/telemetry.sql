-- Plan231: private data, no new login credential or direct runtime table access.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='svitlo_telemetry_owner') then create role svitlo_telemetry_owner nologin nobypassrls;end if;
end $$;
create schema svitlo_telemetry authorization svitlo_telemetry_owner;
revoke all on schema svitlo_telemetry from public;
grant usage on schema svitlo_telemetry to svitlo_stage_api,svitlo_stage_worker;
grant usage on schema auth to svitlo_telemetry_owner;
grant execute on function auth.uid() to svitlo_telemetry_owner;
create table svitlo_telemetry.policy (
 id boolean primary key default true check(id),security_enabled boolean not null default true,
 reports_per_day integer not null default 5 check(reports_per_day between 1 and 100),
 report_capacity integer not null default 10000 check(report_capacity between 1 and 100000),
 security_per_minute integer not null default 30 check(security_per_minute between 1 and 1000),
 security_capacity integer not null default 2000 check(security_capacity between 1 and 100000)
);
insert into svitlo_telemetry.policy(id) values(true);
create table svitlo_telemetry.receipts (
 owner uuid not null references auth.users(id) on delete cascade, report_id uuid not null,
 receipt_id uuid not null unique default gen_random_uuid(),packet_hash text not null,
 accepted_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '35 days',
 primary key(owner,report_id)
);
create index telemetry_receipts_owner_time on svitlo_telemetry.receipts(owner,accepted_at);
create index telemetry_receipts_expiry on svitlo_telemetry.receipts(expires_at);
create table svitlo_telemetry.reports (
 receipt_id uuid primary key references svitlo_telemetry.receipts(receipt_id) on delete cascade,
 packet jsonb not null,expires_at timestamptz not null default now()+interval '30 days'
);
create index telemetry_reports_expiry on svitlo_telemetry.reports(expires_at);
create table svitlo_telemetry.security_events (
 event_id uuid primary key default gen_random_uuid(),occurred_at timestamptz not null default now(),
 operation text not null check(operation in ('catalog_lookup','profile_write','diagnostic_report')),
 field text not null check(field in ('city','street','house','name','request')),
 reason text not null check(reason in ('schema','size','control','operation','owner','rate')),
 confidence text not null check(confidence in ('schema_violation','heuristic')),
 source text not null check(source in ('api','edge','database')),correlation_id uuid
);
create index telemetry_security_expiry on svitlo_telemetry.security_events(occurred_at);
create index telemetry_security_dedupe on svitlo_telemetry.security_events(operation,field,reason,occurred_at desc);
create table svitlo_telemetry.admin_audit (
 audit_id uuid primary key default gen_random_uuid(),occurred_at timestamptz not null default now(),
 actor text not null,operation text not null,items integer not null
);
create index telemetry_audit_expiry on svitlo_telemetry.admin_audit(occurred_at);

create function svitlo_telemetry.valid_report(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare e jsonb;begin
 if p is null or jsonb_typeof(p) is distinct from 'object' then return false;end if;
 if octet_length(p::text)>8192 or not(p ?& array['schemaVersion','reportId','client','occurredAt','stage','code','events'])
 or p-array['schemaVersion','reportId','client','occurredAt','stage','code','events','httpStatus','correlationId']<>'{}'::jsonb then return false;end if;
 if p->'schemaVersion'<>'1'::jsonb or jsonb_typeof(p->'reportId')<>'string' or (p->>'reportId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return false;end if;
 if jsonb_typeof(p->'client') is distinct from 'object' then return false;end if;
 if not((p->'client') ?& array['target','version']) or (p->'client')-array['target','version']<>'{}'::jsonb then return false;end if;
 if coalesce(p#>>'{client,target}','') not in ('android','pwa') or jsonb_typeof(p#>'{client,version}')<>'string' or length(p#>>'{client,version}') not between 1 and 40 or (p#>>'{client,version}')!~'^[A-Za-z0-9._-]+$' then return false;end if;
 if jsonb_typeof(p->'occurredAt')<>'string' or length(p->>'occurredAt')>30 or (p->>'occurredAt')!~*'^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:\d{2})$' then return false;end if;
 begin perform (p->>'occurredAt')::timestamptz;exception when others then return false;end;
 if coalesce(p->>'stage','') not in ('city','street','house','submit') or coalesce(p->>'code','') not in ('empty','temporary','timeout','offline') then return false;end if;
 if p ? 'httpStatus' then if jsonb_typeof(p->'httpStatus')<>'number' or (p->>'httpStatus')!~'^\d{3}$' then return false;end if;if (p->>'httpStatus')::integer not between 100 and 599 then return false;end if;end if;
 -- Correlation input has already been authenticated by the server HMAC verifier. Persist only UUID.
 if p ? 'correlationId' then if jsonb_typeof(p->'correlationId')<>'string' or (p->>'correlationId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return false;end if;end if;
 if jsonb_typeof(p->'events')<>'array' then return false;end if;
 if jsonb_array_length(p->'events') not between 1 and 8 then return false;end if;
 for e in select value from jsonb_array_elements(p->'events') loop
  if jsonb_typeof(e) is distinct from 'object' then return false;end if;
  if not(e ?& array['name','code']) or e-array['name','code']<>'{}'::jsonb or coalesce(e->>'name','') not in ('lookup_started','lookup_failed','retry_requested') or coalesce(e->>'code','') not in ('empty','temporary','timeout','offline') then return false;end if;
 end loop;return true;
end $$;

create function svitlo_telemetry.submit_report(p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare subject uuid:=auth.uid();r svitlo_telemetry.receipts;hash text;cfg svitlo_telemetry.policy;midnight timestamptz:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';begin
 if subject is null then raise insufficient_privilege;end if;
 if not svitlo_telemetry.valid_report(p) then return jsonb_build_object('status','invalid');end if;
 perform pg_advisory_xact_lock(311032104);
 hash:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 select * into r from svitlo_telemetry.receipts where owner=subject and report_id=(p->>'reportId')::uuid;
 if found then
  if hash<>r.packet_hash then return jsonb_build_object('status','conflict');end if;
  return jsonb_build_object('status','duplicate','schemaVersion',1,'reportId',r.report_id,'receiptId',r.receipt_id,'acceptedAt',r.accepted_at);
 end if;
 select * into cfg from svitlo_telemetry.policy where id;
 if (select count(*) from svitlo_telemetry.receipts where owner=subject and accepted_at>=midnight)>=cfg.reports_per_day then
  return jsonb_build_object('status','quota','retryAfter',greatest(1,ceil(extract(epoch from midnight+interval '1 day'-now()))::integer));end if;
 if (select count(*) from svitlo_telemetry.reports where expires_at>now())>=cfg.report_capacity then return jsonb_build_object('status','capacity','retryAfter',60);end if;
 insert into svitlo_telemetry.receipts(owner,report_id,packet_hash) values(subject,(p->>'reportId')::uuid,hash) returning * into r;
 insert into svitlo_telemetry.reports(receipt_id,packet) values(r.receipt_id,p);
 return jsonb_build_object('status','created','schemaVersion',1,'reportId',r.report_id,'receiptId',r.receipt_id,'acceptedAt',r.accepted_at);
end $$;

create function svitlo_telemetry.record_security(p jsonb) returns text language plpgsql security definer set search_path='' as $$
declare cfg svitlo_telemetry.policy;begin
 if p is null or jsonb_typeof(p) is distinct from 'object' then return 'invalid';end if;
 if p-array['operation','field','reason','confidence','source','correlationId']<>'{}'::jsonb or not(p ?& array['operation','field','reason','confidence','source'])
 or coalesce(p->>'operation','') not in ('catalog_lookup','profile_write','diagnostic_report') or coalesce(p->>'field','') not in ('city','street','house','name','request') or coalesce(p->>'reason','') not in ('schema','size','control','operation','owner','rate')
 or coalesce(p->>'confidence','') not in ('schema_violation','heuristic') or coalesce(p->>'source','') not in ('api','edge','database') then return 'invalid';end if;
 if p ? 'correlationId' and (jsonb_typeof(p->'correlationId')<>'string' or (p->>'correlationId')!~*'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') then return 'invalid';end if;
 if not pg_try_advisory_xact_lock(311032105) then return 'busy';end if;
 select * into cfg from svitlo_telemetry.policy where id;
 if not cfg.security_enabled then return 'disabled';end if;
 if exists(select 1 from svitlo_telemetry.security_events where operation=p->>'operation' and field=p->>'field' and reason=p->>'reason' and occurred_at>now()-interval '60 seconds') then return 'duplicate';end if;
 if (select count(*) from svitlo_telemetry.security_events where occurred_at>now()-interval '1 minute')>=cfg.security_per_minute then return 'rate';end if;
 if (select count(*) from svitlo_telemetry.security_events where occurred_at>now()-interval '14 days')>=cfg.security_capacity then return 'capacity';end if;
 insert into svitlo_telemetry.security_events(operation,field,reason,confidence,source,correlation_id) values(p->>'operation',p->>'field',p->>'reason',p->>'confidence',p->>'source',(p->>'correlationId')::uuid);
 return 'stored';
end $$;

create function svitlo_telemetry.forget_reports() returns void language plpgsql security definer set search_path='' as $$
begin if auth.uid() is null then raise insufficient_privilege;end if;delete from svitlo_telemetry.receipts where owner=auth.uid();end $$;
create function svitlo_telemetry.cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare payloads integer;receipts integer;events integer;audits integer;begin
 delete from svitlo_telemetry.reports where receipt_id in(select receipt_id from svitlo_telemetry.reports where expires_at<now() limit 1000);get diagnostics payloads=row_count;
 delete from svitlo_telemetry.receipts where receipt_id in(select receipt_id from svitlo_telemetry.receipts where expires_at<now() limit 1000);get diagnostics receipts=row_count;
 delete from svitlo_telemetry.security_events where event_id in(select event_id from svitlo_telemetry.security_events where occurred_at<now()-interval '14 days' limit 1000);get diagnostics events=row_count;
 delete from svitlo_telemetry.admin_audit where audit_id in(select audit_id from svitlo_telemetry.admin_audit where occurred_at<now()-interval '90 days' limit 1000);get diagnostics audits=row_count;
 return jsonb_build_object('payloads',payloads,'receipts',receipts,'events',events,'audits',audits);
end $$;
create function svitlo_telemetry.admin_read(kind text,amount integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare items jsonb;audit uuid;begin
 if coalesce(kind,'') not in ('diagnostics','security') or amount is null or amount not between 1 and 100 then raise exception 'Invalid admin operation';end if;
 if kind='diagnostics' then select coalesce(jsonb_agg(to_jsonb(q)),'[]') into items from(select r.receipt_id,r.accepted_at,p.packet from svitlo_telemetry.receipts r join svitlo_telemetry.reports p using(receipt_id) order by r.accepted_at desc,r.receipt_id limit amount) q;
 else select coalesce(jsonb_agg(to_jsonb(q)),'[]') into items from(select * from svitlo_telemetry.security_events order by occurred_at desc,event_id limit amount) q;end if;
 insert into svitlo_telemetry.admin_audit(actor,operation,items) values(session_user,'read_'||kind,jsonb_array_length(items)) returning audit_id into audit;
 delete from svitlo_telemetry.admin_audit where audit_id in(select audit_id from svitlo_telemetry.admin_audit order by occurred_at desc offset 1000);
 return jsonb_build_object('kind',kind,'items',items,'auditId',audit,'readAt',now());
end $$;
create function svitlo_telemetry.admin_collection(enabled boolean) returns void language plpgsql security definer set search_path='' as $$
begin update svitlo_telemetry.policy set security_enabled=enabled where id;insert into svitlo_telemetry.admin_audit(actor,operation,items) values(session_user,case when enabled then 'collection_on' else 'collection_off' end,0);end $$;

-- Dedicated non-login function owner has no credentials and receives no role membership.
do $$ declare t text;f record;begin
 foreach t in array array['policy','receipts','reports','security_events','admin_audit'] loop
  execute format('alter table svitlo_telemetry.%I enable row level security',t);
  execute format('revoke all on table svitlo_telemetry.%I from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker',t);
  execute format('alter table svitlo_telemetry.%I owner to svitlo_telemetry_owner',t);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='svitlo_telemetry' loop
  execute format('revoke all on function %s from public',f.signature);
  execute format('alter function %s owner to svitlo_telemetry_owner',f.signature);
 end loop;
end $$;
grant execute on function svitlo_telemetry.submit_report(jsonb),svitlo_telemetry.record_security(jsonb),svitlo_telemetry.forget_reports() to svitlo_stage_api;
grant execute on function svitlo_telemetry.cleanup() to svitlo_stage_worker;
-- Admin functions intentionally have no runtime grant; only trusted SSH/DB administration can invoke them.
