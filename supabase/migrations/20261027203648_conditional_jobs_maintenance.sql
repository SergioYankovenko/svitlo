-- Private scheduler state never exposes Vault headers or the saved cron command.
create schema if not exists svitlo_internal;
revoke all on schema svitlo_internal from public,anon,authenticated,service_role;
create table svitlo_internal.scheduler (
 id boolean primary key default true check(id),enabled boolean not null default false,previous_command text,
 last_tick bigint not null default 0,skipped bigint not null default 0,dispatched bigint not null default 0,
 pending_until bigint not null default 0,last_request_id bigint,
 next_maintenance bigint not null default 0,last_maintenance bigint not null default 0,maintenance_summary jsonb not null default '{}',maintenance_error text
);
insert into svitlo_internal.scheduler(id) values(true);
alter table svitlo_internal.scheduler enable row level security;
revoke all on svitlo_internal.scheduler from public,anon,authenticated,service_role;

-- Readiness uses indexes and makes no claims. Do not validate individual deliveries
-- here: the bounded claim must be allowed to repair unexpected invalid rows.
create function public.svitlo_jobs_work(now_ms bigint) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
 'profiles',exists(select 1 from public.svitlo_profiles p where p.push_enabled and p.lease_until<now_ms
  and ((p.next_check>0 and p.next_check<=now_ms) or (p.next_check=0 and p.last_checked<now_ms-3600000))),
 'reminders',exists(select 1 from public.svitlo_reminder_tasks t join public.svitlo_profiles p on p.id=t.profile_id
  where p.push_enabled and t.due_at>0 and t.due_at<=now_ms and t.lease_until<now_ms),
 'deliveries',exists(select 1 from public.svitlo_deliveries d where not d.sent and not d.cancelled and d.attempts<5
  and d.expires_at>now_ms and d.lease_until<now_ms),
 'feed',exists(select 1 from public.svitlo_profiles where push_enabled)
  and exists(select 1 from public.svitlo_feed_state where next_refresh<=now_ms and lease_until<now_ms)
 );
$$;
revoke all on function public.svitlo_jobs_work(bigint) from public,anon,authenticated;
grant execute on function public.svitlo_jobs_work(bigint) to service_role;

-- Only cron/administrators execute retention. Row locks serialize maintenance;
-- a failed transaction rolls back both deletions and the next-run timestamp.
create function svitlo_internal.maintenance(now_ms bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s svitlo_internal.scheduler; n integer; remaining boolean:=false; result jsonb:='{}';
begin
 select * into s from svitlo_internal.scheduler where id;
 if s.next_maintenance>now_ms then return jsonb_build_object('status','not_due'); end if;
 select * into s from svitlo_internal.scheduler where id for update skip locked;
 if not found then return jsonb_build_object('status','busy'); end if;
 if s.next_maintenance>now_ms then return jsonb_build_object('status','not_due'); end if;

 delete from public.svitlo_shared_plans where id in(select v.id from public.svitlo_shared_plans v
  where v.created_at<to_timestamp(now_ms/1000.0)-interval '7 days'
  and not exists(select 1 from public.svitlo_profiles p where p.snapshot->>'_plansRef'=v.id) limit 500);
 get diagnostics n=row_count;result:=result||jsonb_build_object('plans',n);remaining:=remaining or n>=500;
 delete from public.svitlo_source_cache where key in(select key from public.svitlo_source_cache where touched_at<now_ms-86400000 limit 1000);
 get diagnostics n=row_count;result:=result||jsonb_build_object('sources',n);remaining:=remaining or n>=1000;
 delete from public.svitlo_deliveries where id in(select id from public.svitlo_deliveries where expires_at<now_ms-604800000 limit 1000);
 get diagnostics n=row_count;result:=result||jsonb_build_object('deliveries',n);remaining:=remaining or n>=1000;
 n:=public.svitlo_delivery_prune(now_ms,1000);result:=result||jsonb_build_object('expiredDeliveries',n);remaining:=remaining or n>=1000;
 delete from public.svitlo_limits where owner in(select owner from public.svitlo_limits where started_at<now_ms-86400000 limit 1000);
 get diagnostics n=row_count;result:=result||jsonb_build_object('limits',n);remaining:=remaining or n>=1000;
 delete from public.svitlo_previews where ctid in(select ctid from public.svitlo_previews where expires_at<now_ms limit 1000);
 get diagnostics n=row_count;result:=result||jsonb_build_object('previews',n);remaining:=remaining or n>=1000;
 delete from public.svitlo_dictionary_cache where key in(select key from public.svitlo_dictionary_cache where stale_until<now_ms and lease_until<now_ms-60000 limit 1000);
 get diagnostics n=row_count;result:=result||jsonb_build_object('dictionaries',n);remaining:=remaining or n>=1000;
 delete from public.svitlo_provider_leases where id in(select id from public.svitlo_provider_leases where expires_at<now_ms limit 1000);
 get diagnostics n=row_count;result:=result||jsonb_build_object('leases',n);remaining:=remaining or n>=1000;
 delete from public.svitlo_job_runs where id in(select id from public.svitlo_job_runs where started_at<now_ms-1209600000 limit 1000);
 get diagnostics n=row_count;result:=result||jsonb_build_object('runs',n);remaining:=remaining or n>=1000;
 delete from public.svitlo_registry_candidates where id in(select id from public.svitlo_registry_candidates where last_seen_at<now_ms-7776000000 limit 100);
 get diagnostics n=row_count;result:=result||jsonb_build_object('candidates',n);remaining:=remaining or n>=100;
 if to_regclass('cron.job_run_details') is not null then
  delete from cron.job_run_details where runid in(select runid from cron.job_run_details where start_time<to_timestamp(now_ms/1000.0)-interval '14 days' limit 1000);
  get diagnostics n=row_count;result:=result||jsonb_build_object('cronRuns',n);remaining:=remaining or n>=1000;
 end if;
 update svitlo_internal.scheduler set last_maintenance=now_ms,next_maintenance=now_ms+case when remaining then 60000 else 3600000 end,
  maintenance_summary=result,maintenance_error=null where id;
 return jsonb_build_object('status','completed','removed',result,'backlog',remaining);
end $$;

create function svitlo_internal.dispatch() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s svitlo_internal.scheduler; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
 w jsonb; secret text; request_id bigint;
begin
 -- Fast timeout detection remains every minute, independently of retention.
 update public.svitlo_job_runs set status='failed',error_code='execution_timeout',finished_at=t
  where status='running' and started_at<t-300000;
 begin
  perform svitlo_internal.maintenance(t);
 exception when others then
  -- Retention failure must never block time-sensitive reminders. Store only
  -- SQLSTATE, not exception text that might contain source data or secrets.
  update svitlo_internal.scheduler set maintenance_error=SQLSTATE where id;
 end;
 select * into s from svitlo_internal.scheduler where id for update skip locked;
 if not found then return jsonb_build_object('status','busy'); end if;
 if not s.enabled then return jsonb_build_object('status','disabled'); end if;
 update svitlo_internal.scheduler set last_tick=t where id;
 if s.pending_until>t or exists(select 1 from public.svitlo_jobs_state where lease_until>t) then
  update svitlo_internal.scheduler set skipped=skipped+1 where id;
  return jsonb_build_object('status','busy');
 end if;
 w:=public.svitlo_jobs_work(t);
 if not exists(select 1 from jsonb_each(w) e where e.value='true'::jsonb) then
  update svitlo_internal.scheduler set skipped=skipped+1 where id;
  return jsonb_build_object('status','idle');
 end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='svitlo_cron_secret';
 if secret is null or length(secret)<32 then raise exception 'cron credential unavailable'; end if;
 request_id:=net.http_post(url:='https://ovcmluucwzsuflusebcc.supabase.co/functions/v1/svitlo-jobs',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=60000);
 update svitlo_internal.scheduler set pending_until=t+90000,last_request_id=request_id,dispatched=dispatched+1 where id;
 return jsonb_build_object('status','dispatched','requestId',request_id,'work',w);
end $$;

-- Trigger privilege is confined to an unexposed schema. Clients cannot execute
-- this function or update the service-only jobs table. A completed worker releases
-- the pending HTTP guard so the following minute can process a remaining backlog.
create function svitlo_internal.jobs_finished() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if old.token is not null and new.token is null then update svitlo_internal.scheduler set pending_until=0 where id; end if;
 return new;
end $$;
create trigger svitlo_jobs_dispatch_finished after update on public.svitlo_jobs_state
for each row execute function svitlo_internal.jobs_finished();

-- Activation is separate from schema deployment: deploy the compatible worker first.
create function svitlo_internal.enable_scheduler() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j record; saved text;
begin
 if (select count(*) from cron.job where jobname='svitlo-minute')<>1 then raise exception 'expected one svitlo-minute job'; end if;
 select * into j from cron.job where jobname='svitlo-minute';
 select previous_command into saved from svitlo_internal.scheduler where id for update;
 if saved is not null and j.command<>'select svitlo_internal.dispatch();' and j.command<>saved then raise exception 'cron command changed externally'; end if;
 if saved is null then update svitlo_internal.scheduler set previous_command=j.command where id; end if;
 perform cron.alter_job(j.jobid,command:='select svitlo_internal.dispatch();');
 update svitlo_internal.scheduler set enabled=true where id;
 return jsonb_build_object('status','enabled','jobId',j.jobid,'active',j.active);
end $$;
create function svitlo_internal.disable_scheduler() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j record; saved text;
begin
 select previous_command into saved from svitlo_internal.scheduler where id for update;
 if saved is null then return jsonb_build_object('status','not_enabled'); end if;
 select * into j from cron.job where jobname='svitlo-minute';
 if j.command<>'select svitlo_internal.dispatch();' then raise exception 'cron command changed externally'; end if;
 perform cron.alter_job(j.jobid,command:=saved);
 update svitlo_internal.scheduler set enabled=false,pending_until=0 where id;
 return jsonb_build_object('status','restored','jobId',j.jobid);
end $$;
revoke all on all functions in schema svitlo_internal from public,anon,authenticated,service_role;

create index svitlo_running_jobs_timeout on public.svitlo_job_runs(started_at) where status='running';
