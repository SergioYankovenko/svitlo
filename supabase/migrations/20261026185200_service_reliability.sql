create table public.svitlo_previews (
 owner uuid not null references auth.users(id) on delete cascade,
 address_key text not null check(length(address_key)<=600),
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 prepared jsonb not null check(jsonb_typeof(prepared)='object' and not(prepared ? 'account') and octet_length(prepared::text)<=1000000),
 checked_at bigint not null, expires_at bigint not null,
 primary key(owner,address_key)
);
create index svitlo_previews_expiry on public.svitlo_previews(expires_at);
create table public.svitlo_dictionary_cache (
 key text primary key check(key like 'dictionary:%' and length(key)<=200),
 value jsonb, checked_at bigint, expires_at bigint not null default 0,
 stale_until bigint not null default 0, token uuid, lease_until bigint not null default 0,
 last_error text, error_at bigint
);
create index svitlo_dictionary_cache_expiry on public.svitlo_dictionary_cache(stale_until);
create table public.svitlo_provider_hosts (
 host text primary key check(host in ('cabinet.cherkasyoblenergo.com','www.cherkasyoblenergo.com')),
 next_start bigint not null default 0, cooldown_until bigint not null default 0,
 cooldown_code text, failures integer not null default 0, last_status integer,
 last_error text, last_success bigint, updated_at bigint not null default 0
);
create table public.svitlo_provider_leases (
 id uuid primary key default gen_random_uuid(),
 host text not null references public.svitlo_provider_hosts(host), expires_at bigint not null
);
create index svitlo_provider_lease_host on public.svitlo_provider_leases(host,expires_at);
create table public.svitlo_job_runs (
 id uuid primary key default gen_random_uuid(), job text not null check(job in ('jobs','registry')),
 started_at bigint not null, finished_at bigint, status text not null default 'running'
 check(status in ('running','succeeded','partial','failed','not_due','needs_review')),
 summary jsonb not null default '{}'::jsonb, error_code text
);
create index svitlo_job_runs_recent on public.svitlo_job_runs(job,started_at desc);
create table public.svitlo_registry_candidates (
 id text primary key, base_version text, created_at bigint not null,
 last_seen_at bigint not null, status text not null default 'held' check(status in ('held','superseded','activated')),
 reason text not null, summary jsonb not null, payload jsonb not null
);
create table public.svitlo_registry_approvals (
 version_id text not null, base_version text not null, payload_sha256 text not null check(length(payload_sha256)=64),
 approved_at bigint not null, approved_by text not null, reason text not null check(length(reason) between 10 and 500),
 primary key(version_id,base_version,payload_sha256)
);
do $$ declare name text; begin
 foreach name in array array['svitlo_previews','svitlo_dictionary_cache','svitlo_provider_hosts','svitlo_provider_leases','svitlo_job_runs','svitlo_registry_candidates','svitlo_registry_approvals'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated',name);
  execute format('grant select,insert,update,delete on public.%I to service_role',name);
 end loop;
end $$;

create function public.svitlo_preview_put(subject uuid,cache_key text,proof text,prepared_data jsonb,checked_ms bigint)
returns void language plpgsql security invoker set search_path='' as $$
declare t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 if checked_ms<t-60000 or checked_ms>t+5000 then return; end if;
 perform pg_advisory_xact_lock(82516,hashtext(subject::text));
 delete from public.svitlo_previews where owner=subject and expires_at<=t;
 if (select count(*) from public.svitlo_previews where owner=subject)>=10
    and not exists(select 1 from public.svitlo_previews where owner=subject and address_key=cache_key) then
  delete from public.svitlo_previews where owner=subject and address_key in
   (select address_key from public.svitlo_previews where owner=subject order by checked_at limit 1);
 end if;
 insert into public.svitlo_previews(owner,address_key,fingerprint,prepared,checked_at,expires_at)
 values(subject,cache_key,proof,prepared_data,checked_ms,checked_ms+60000)
 on conflict(owner,address_key) do update set fingerprint=excluded.fingerprint,prepared=excluded.prepared,
  checked_at=excluded.checked_at,expires_at=excluded.expires_at
 where public.svitlo_previews.checked_at<=excluded.checked_at;
end $$;
create function public.svitlo_preview_take(subject uuid,cache_key text,proof text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.svitlo_previews; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 delete from public.svitlo_previews where owner=subject and address_key=cache_key returning * into item;
 if item.fingerprint=proof and item.expires_at>t and item.checked_at<=t+5000 then return item.prepared; end if;
 return null;
end $$;

create function public.svitlo_dictionary_claim(cache_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare item public.svitlo_dictionary_cache; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; claim uuid;
begin
 insert into public.svitlo_dictionary_cache(key) values(cache_key) on conflict do nothing;
 select * into item from public.svitlo_dictionary_cache where key=cache_key for update;
 if item.value is not null and item.expires_at>t then
  return jsonb_build_object('state','fresh','items',item.value,'checkedAt',item.checked_at);
 end if;
 if item.lease_until>t then
  return jsonb_build_object('state','busy','items',case when item.stale_until>t then item.value end,'checkedAt',item.checked_at);
 end if;
 claim:=gen_random_uuid();
 update public.svitlo_dictionary_cache set token=claim,lease_until=t+30000 where key=cache_key;
 return jsonb_build_object('state','owner','token',claim,'items',case when item.stale_until>t then item.value end,'checkedAt',item.checked_at);
end $$;
create function public.svitlo_dictionary_finish(cache_key text,claim uuid,items jsonb,error_code text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; n integer;
begin
 if items is not null and (jsonb_typeof(items)<>'array' or octet_length(items::text)>2000000) then
  raise exception 'Invalid dictionary cache';
 end if;
 update public.svitlo_dictionary_cache set
  value=case when items is not null then items else value end,
  checked_at=case when items is not null then t else checked_at end,
  expires_at=case when items is not null then t+3600000 else expires_at end,
  stale_until=case when items is not null then t+90000000 else stale_until end,
  token=null,lease_until=0,last_error=left(error_code,40),error_at=case when error_code is not null then t end
 where key=cache_key and token=claim and lease_until>=t;
 get diagnostics n=row_count;return n=1;
end $$;

create function public.svitlo_provider_acquire(provider_host text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare item public.svitlo_provider_hosts; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint; claim uuid;
begin
 insert into public.svitlo_provider_hosts(host) values(provider_host) on conflict do nothing;
 select * into item from public.svitlo_provider_hosts where host=provider_host for update;
 delete from public.svitlo_provider_leases where host=provider_host and expires_at<=t;
 if item.cooldown_until>t then
  return jsonb_build_object('granted',false,'reason','cooldown','code',item.cooldown_code,'waitMs',item.cooldown_until-t);
 end if;
 if item.next_start>t then return jsonb_build_object('granted',false,'reason','spacing','waitMs',item.next_start-t); end if;
 if (select count(*) from public.svitlo_provider_leases where host=provider_host)>=4 then
  return jsonb_build_object('granted',false,'reason','busy','waitMs',250);
 end if;
 claim:=gen_random_uuid();
 insert into public.svitlo_provider_leases(id,host,expires_at) values(claim,provider_host,t+30000);
 update public.svitlo_provider_hosts set next_start=t+250,cooldown_code=null,updated_at=t where host=provider_host;
 return jsonb_build_object('granted',true,'token',claim);
end $$;
create function public.svitlo_provider_finish(claim uuid,http_status integer,error_code text default null,retry_ms bigint default 0)
returns void language plpgsql security invoker set search_path='' as $$
declare provider_host text; item public.svitlo_provider_hosts; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
 delay_ms bigint:=0; reason text; next_failures integer;
begin
 select host into provider_host from public.svitlo_provider_leases where id=claim;
 if provider_host is null then return; end if;
 select * into item from public.svitlo_provider_hosts where host=provider_host for update;
 if not exists(select 1 from public.svitlo_provider_leases where id=claim) then return; end if;
 delete from public.svitlo_provider_leases where id=claim;
 next_failures:=case when http_status>=500 or error_code is not null then item.failures+1 else 0 end;
 if http_status=403 then delay_ms:=greatest(300000,least(retry_ms,900000));reason:='forbidden';
 elsif http_status=429 then delay_ms:=greatest(60000,least(retry_ms,900000));reason:='rate_limited';
 elsif (http_status>=500 or error_code is not null) and next_failures>=3 then
  delay_ms:=least(300000,30000*power(2,least(next_failures-3,4))::bigint);reason:=coalesce(error_code,'server_error');
 elsif http_status>=500 and retry_ms>0 then delay_ms:=least(retry_ms,900000);reason:='server_error'; end if;
 update public.svitlo_provider_hosts set failures=next_failures,last_status=http_status,last_error=left(error_code,40),
  last_success=case when http_status between 200 and 299 and error_code is null then t else last_success end,
  cooldown_code=case when delay_ms>0 and t+delay_ms>cooldown_until then reason else cooldown_code end,
  cooldown_until=greatest(cooldown_until,t+delay_ms),updated_at=t where host=provider_host;
end $$;

create function public.svitlo_ops_cleanup() returns void
language sql security invoker set search_path='' as $$
 update public.svitlo_job_runs set status='failed',error_code='execution_timeout',finished_at=(extract(epoch from clock_timestamp())*1000)::bigint
  where status='running' and started_at<(extract(epoch from clock_timestamp())*1000)::bigint-300000;
 delete from public.svitlo_previews where expires_at<(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from public.svitlo_dictionary_cache where stale_until<(extract(epoch from clock_timestamp())*1000)::bigint and lease_until<(extract(epoch from clock_timestamp())*1000)::bigint-60000;
 delete from public.svitlo_provider_leases where expires_at<(extract(epoch from clock_timestamp())*1000)::bigint;
 delete from public.svitlo_job_runs where started_at<(extract(epoch from clock_timestamp())*1000)::bigint-1209600000;
 delete from public.svitlo_registry_candidates where last_seen_at<(extract(epoch from clock_timestamp())*1000)::bigint-7776000000;
$$;
revoke all on function public.svitlo_preview_put(uuid,text,text,jsonb,bigint),public.svitlo_preview_take(uuid,text,text),
 public.svitlo_dictionary_claim(text),public.svitlo_dictionary_finish(text,uuid,jsonb,text),
 public.svitlo_provider_acquire(text),public.svitlo_provider_finish(uuid,integer,text,bigint),public.svitlo_ops_cleanup()
 from public,anon,authenticated;
grant execute on function public.svitlo_preview_put(uuid,text,text,jsonb,bigint),public.svitlo_preview_take(uuid,text,text),
 public.svitlo_dictionary_claim(text),public.svitlo_dictionary_finish(text,uuid,jsonb,text),
 public.svitlo_provider_acquire(text),public.svitlo_provider_finish(uuid,integer,text,bigint),public.svitlo_ops_cleanup()
 to service_role;

create table public.svitlo_registry_controls (
 batch_id uuid not null, department text not null, city_id text not null, street_id text not null,house text not null,
 expected_status text not null check(expected_status in ('numeric','not_in_queue','service')),
 primary key(batch_id,department,city_id,street_id,house),
 foreign key(batch_id,department,city_id,street_id,house)
 references public.svitlo_address_queues(batch_id,department,city_id,street_id,house)
);
alter table public.svitlo_registry_controls enable row level security;
revoke all on public.svitlo_registry_controls from public,anon,authenticated;
grant select,insert,update,delete on public.svitlo_registry_controls to service_role;
insert into public.svitlo_registry_controls(batch_id,department,city_id,street_id,house,expected_status)
select q.batch_id,q.department,q.city_id,q.street_id,q.house,q.status
from public.svitlo_address_queues q join public.svitlo_address_queue_batches b on b.id=q.batch_id
join (values ('806','11699','0'),('804','11695','1'),('801','11685','10'),('801','11685','1/а'),
 ('801','11761','14'),('822','11741','1'),('801','12068','15'),('801','11807','10а/51'),
 ('801','12073','9  г'),('801','12073','9 г')) as x(city_id,street_id,house)
on x.city_id=q.city_id and x.street_id=q.street_id and x.house=q.house
where b.status='active' and b.import_key='branch18-20261026-864180d7d543' and q.department='18';

create function public.svitlo_registry_safety(candidate jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare old_id text; eligible bigint; changed_count bigint; reviewed_count bigint; invalid_count bigint;
 controls_count bigint; bad_controls bigint; missing_carried bigint; reviewed boolean; reconciliation jsonb:=candidate->'addressReconciliation';
begin
 select id into old_id from public.svitlo_queue_versions where active;
 if old_id is not distinct from candidate->>'id' or not exists(select 1 from public.svitlo_address_queue_batches where status='active') then
  return jsonb_build_object('approved',true,'reason','unchanged_or_initial','changed',0);
 end if;
 if reconciliation is null or reconciliation->>'previous_registry_id' is distinct from old_id
    or jsonb_typeof(reconciliation->'batches') is distinct from 'array' then
  return jsonb_build_object('approved',false,'reason','missing_or_stale_reconciliation');
 end if;
 select count(*) into eligible from public.svitlo_effective_address_queues where status<>'service';
 select exists(select 1 from public.svitlo_registry_approvals a where a.version_id=candidate->>'id' and a.base_version=old_id
  and a.payload_sha256=encode(sha256(convert_to(candidate::text,'UTF8')),'hex')) into reviewed;
 with proposed as (
  select b->>'batch_id' as batch_id,o as item from jsonb_array_elements(reconciliation->'batches') b
  cross join lateral jsonb_array_elements(case when jsonb_typeof(b->'overrides')='array' then b->'overrides' else '[]'::jsonb end) o
 ), compared as (
  select p.item,e.status as old_status,e.queue as old_queue,e.evidence as old_evidence,e.batch_id,
   (e.queue is distinct from p.item->>'queue' or e.status is distinct from p.item->>'status') as different
  from proposed p left join public.svitlo_effective_address_queues e on e.batch_id::text=p.batch_id
   and e.department=p.item->>'department' and e.city_id=p.item->>'city_id'
   and e.street_id=p.item->>'street_id' and e.house=p.item->>'house'
 )
 select count(*) filter(where different),
  count(*) filter(where item#>>'{evidence,needsReview}'='true' and coalesce(old_evidence->>'needsReview','false')<>'true'),
  count(*) filter(where batch_id is null or old_status='service' or old_status is distinct from item->>'status'
   or (different and (coalesce(item#>>'{evidence,origin}','')<>'provider_pdf_change'
    or coalesce(item->>'queue','') !~ '^[1-6]\.[12]$'
    or coalesce(item#>>'{evidence,pdf_mapping,scope}','') not in ('house','street_all','settlement_all')
    or coalesce(item#>>'{evidence,pdf_mapping,page}','') !~ '^([1-9][0-9]{0,2}|1000)$'
    or not exists(select 1 from jsonb_array_elements(candidate->'documents') d
       where d->>'queue'=item->>'queue' and d->>'url'=item#>>'{evidence,pdf_mapping,url}'
        and d->>'url' like 'https://www.cherkasyoblenergo.com/cherkasyoblenergo/uploads/pages/files/%.pdf'))))
 into changed_count,reviewed_count,invalid_count from compared;
 select count(*) into missing_carried from public.svitlo_address_queue_overrides o
 join public.svitlo_address_queue_batches b on b.id=o.batch_id and b.status='active'
 where o.version_id=old_id and not exists(
  select 1 from jsonb_array_elements(reconciliation->'batches') rb
  cross join lateral jsonb_array_elements(case when jsonb_typeof(rb->'overrides')='array' then rb->'overrides' else '[]'::jsonb end) x
  where rb->>'batch_id'=o.batch_id::text and x->>'department'=o.department and x->>'city_id'=o.city_id
   and x->>'street_id'=o.street_id and x->>'house'=o.house);
 with proposed as (
  select b->>'batch_id' as batch_id,o as item from jsonb_array_elements(reconciliation->'batches') b
  cross join lateral jsonb_array_elements(case when jsonb_typeof(b->'overrides')='array' then b->'overrides' else '[]'::jsonb end) o
 )
 select count(*),count(*) filter(where e.batch_id is null or
  coalesce(p.item->>'status',e.status)<>c.expected_status or
  (c.expected_status='numeric' and coalesce(p.item->>'queue',e.queue,'') !~ '^[1-6]\.[12]$'))
 into controls_count,bad_controls
 from public.svitlo_registry_controls c join public.svitlo_address_queue_batches b on b.id=c.batch_id and b.status='active'
 left join public.svitlo_effective_address_queues e on e.batch_id=c.batch_id and e.department=c.department
  and e.city_id=c.city_id and e.street_id=c.street_id and e.house=c.house
 left join proposed p on p.batch_id=c.batch_id::text and p.item->>'department'=c.department
  and p.item->>'city_id'=c.city_id and p.item->>'street_id'=c.street_id and p.item->>'house'=c.house;
 return jsonb_build_object('approved',invalid_count=0 and bad_controls=0 and missing_carried=0
   and (reviewed or (not(changed_count>=100 and changed_count*10>=greatest(eligible,1))
   and not(reviewed_count>=100 and reviewed_count*10>=greatest(eligible,1)))),
  'reason',case when invalid_count>0 then 'invalid_change_proof' when bad_controls>0 then 'control_address_failed'
   when missing_carried>0 then 'missing_carried_overrides'
   when not reviewed and changed_count>=100 and changed_count*10>=greatest(eligible,1) then 'mass_queue_change'
   when not reviewed and reviewed_count>=100 and reviewed_count*10>=greatest(eligible,1) then 'mass_uncertainty'
   else 'accepted' end,
  'changed',changed_count,'newReviews',reviewed_count,'eligible',eligible,'controls',controls_count,'badControls',bad_controls,
  'invalidChanges',invalid_count,'missingCarried',missing_carried,'reviewApproved',reviewed,'minimumMassCount',100,'massPercent',10);
end $$;

-- No application route calls this. A privileged operator must inspect the held
-- candidate and explicitly supply a review reason. Approval binds exact bytes
-- and the current base version, and cannot bypass invalid evidence or controls.
create function public.svitlo_review_registry_candidate(candidate_id text,review_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare item public.svitlo_registry_candidates; decision jsonb; t bigint:=(extract(epoch from clock_timestamp())*1000)::bigint;
begin
 perform pg_advisory_xact_lock(743621);
 select * into item from public.svitlo_registry_candidates where id=candidate_id and status='held' for update;
 if item.id is null or length(trim(review_reason)) not between 10 and 500 then raise exception 'Candidate and review reason required'; end if;
 if item.base_version is distinct from (select id from public.svitlo_queue_versions where active) then raise exception 'Candidate base version changed'; end if;
 if (item.payload->>'validFrom')::date>(clock_timestamp() at time zone 'Europe/Kyiv')::date
   or (item.payload->>'validUntil')::date<(clock_timestamp() at time zone 'Europe/Kyiv')::date then raise exception 'Candidate is not currently valid'; end if;
 decision:=public.svitlo_registry_safety(item.payload);
 if not coalesce((decision->>'approved')::boolean,false) and decision->>'reason' not in ('mass_queue_change','mass_uncertainty') then
  raise exception 'Candidate evidence requires repair';
 end if;
 insert into public.svitlo_registry_approvals(version_id,base_version,payload_sha256,approved_at,approved_by,reason)
 values(item.id,item.base_version,encode(sha256(convert_to(item.payload::text,'UTF8')),'hex'),t,current_user,trim(review_reason))
 on conflict(version_id,base_version,payload_sha256) do nothing;
 perform public.svitlo_activate_registry(item.payload);
 update public.svitlo_registry_candidates set status=case when id=item.id then 'activated' else 'superseded' end where status='held';
 update public.svitlo_cache set value=(value-'error'-'pendingVersion'-'review') || jsonb_build_object(
  'lastSuccessAt',(item.payload->>'checkedAt')::bigint,'nextCheckAt',(item.payload->>'checkedAt')::bigint+1209600000,
  'lastReviewedAt',t,'failures',0) where key='queue-registry-state';
 return jsonb_build_object('status','activated','version',item.id);
end $$;

create function public.svitlo_service_report() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'generatedAt',(extract(epoch from now())*1000)::bigint,
  'registry',(select value from public.svitlo_cache where key='queue-registry-state'),
  'limits',jsonb_build_object('perHostConcurrent',4,'perHostStartsPerSecond',4,'previewSeconds',60,
   'dictionaryFreshSeconds',3600,'dictionaryStaleSeconds',86400,'registryIntervalDays',14,'massMinimum',100,'massPercent',10),
  'activePdf',(select jsonb_build_object('id',id,'validUntil',valid_until,'checkedAt',checked_at) from public.svitlo_queue_versions where active),
  'catalog',(select jsonb_build_object('total',count(*),'numeric',count(*) filter(where status='numeric'),
   'excluded',count(*) filter(where status='not_in_queue'),'estimated',count(*) filter(where is_estimate),
   'needsReview',count(*) filter(where evidence->>'needsReview'='true')) from public.svitlo_effective_address_queues),
  'dictionaries',(select jsonb_build_object('total',count(*),'fresh',count(*) filter(where expires_at>(extract(epoch from now())*1000)::bigint),
   'staleAvailable',count(*) filter(where expires_at<=(extract(epoch from now())*1000)::bigint and stale_until>(extract(epoch from now())*1000)::bigint),
   'errors',count(*) filter(where last_error is not null)) from public.svitlo_dictionary_cache),
  'providers',(select coalesce(jsonb_agg(jsonb_build_object('host',host,'failures',failures,'lastStatus',last_status,'lastSuccess',last_success,
   'cooldownUntil',cooldown_until,'cooldownCode',cooldown_code,'inFlight',(select count(*) from public.svitlo_provider_leases l where l.host=h.host and l.expires_at>(extract(epoch from now())*1000)::bigint))),'[]'::jsonb) from public.svitlo_provider_hosts h),
  'previews',(select jsonb_build_object('reusable',count(*) filter(where expires_at>(extract(epoch from now())*1000)::bigint)) from public.svitlo_previews),
  'profiles',(select jsonb_build_object('total',count(*),
   'stale',count(*) filter(where (case when snapshot->>'lastSuccessAt' ~ '^[0-9]{1,15}$' then (snapshot->>'lastSuccessAt')::bigint else 0 end)<(extract(epoch from now())*1000)::bigint-7200000),
   'partial',count(*) filter(where (case when jsonb_typeof(snapshot->'failures')='array' then jsonb_array_length(snapshot->'failures') else 0 end)>0 or snapshot->>'feedFailed'='true')) from public.svitlo_profiles),
  'controlAddresses',(select jsonb_build_object('total',count(*),'missing',count(*) filter(where e.batch_id is null),
   'invalid',count(*) filter(where e.status<>c.expected_status or (c.expected_status='numeric' and coalesce(e.queue,'') !~ '^[1-6]\.[12]$')))
   from public.svitlo_registry_controls c join public.svitlo_address_queue_batches b on b.id=c.batch_id and b.status='active'
   left join public.svitlo_effective_address_queues e on e.batch_id=c.batch_id and e.department=c.department and e.city_id=c.city_id and e.street_id=c.street_id and e.house=c.house),
  'jobs',(select coalesce(jsonb_agg(to_jsonb(j)),'[]'::jsonb) from (
   select job,max(started_at) as last_started,max(finished_at) filter(where status='succeeded') as last_success,
    count(*) filter(where status in ('failed','partial') and started_at>(extract(epoch from now())*1000)::bigint-86400000) as failures_24h,
    count(*) filter(where status='running' and started_at<(extract(epoch from now())*1000)::bigint-300000) as stalled
   from public.svitlo_job_runs group by job) j),
  'recentRuns',(select coalesce(jsonb_agg(to_jsonb(j)),'[]'::jsonb) from (select job,started_at,finished_at,status,summary,error_code from public.svitlo_job_runs order by started_at desc limit 20) j),
  'pendingRegistry',(select jsonb_build_object('id',id,'baseVersion',base_version,'createdAt',created_at,'reason',reason,'summary',summary)
   from public.svitlo_registry_candidates where status='held' order by last_seen_at desc limit 1)
 );
$$;
revoke all on function public.svitlo_registry_safety(jsonb),public.svitlo_service_report(),public.svitlo_review_registry_candidate(text,text) from public,anon,authenticated;
grant execute on function public.svitlo_registry_safety(jsonb),public.svitlo_service_report(),public.svitlo_review_registry_candidate(text,text) to service_role;

CREATE OR REPLACE FUNCTION public.svitlo_activate_registry(candidate jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 item jsonb; n integer:=0; old_id text; changed boolean;
 reconciliation jsonb:=candidate->'addressReconciliation'; batch_item jsonb;
 clean_candidate jsonb:=candidate-'addressReconciliation'; active_batches integer;
begin
 perform pg_advisory_xact_lock(743621);
 select id into old_id from public.svitlo_queue_versions where active;
 changed:=old_id is distinct from candidate->>'id';
 if coalesce(jsonb_array_length(candidate->'documents'),0)<>12
    or coalesce(jsonb_array_length(candidate->'rules'),0)<1 then
  raise exception 'Incomplete registry';
 end if;
 select count(*) into active_batches from public.svitlo_address_queue_batches where status='active';
 if changed and active_batches>0 then
  if reconciliation is null or reconciliation->>'previous_registry_id' is distinct from old_id
     or jsonb_typeof(reconciliation->'batches') is distinct from 'array'
     or jsonb_array_length(reconciliation->'batches')<>active_batches then
   raise exception 'Address reconciliation required';
  end if;
  if (select count(distinct x->>'batch_id') from jsonb_array_elements(reconciliation->'batches') x)<>active_batches then
   raise exception 'Duplicate address batch';
  end if;
  for batch_item in select value from jsonb_array_elements(reconciliation->'batches') loop
   if not exists(select 1 from public.svitlo_address_queue_batches b
      where b.id=(batch_item->>'batch_id')::uuid and b.status='active'
        and b.expected_total=(batch_item->>'total')::integer
        and b.expected_total=(select count(*) from public.svitlo_address_queues q where q.batch_id=b.id))
      or jsonb_typeof(batch_item->'overrides') is distinct from 'array'
      or jsonb_array_length(batch_item->'overrides')>(batch_item->>'total')::integer then
    raise exception 'Incomplete or superseded address batch';
   end if;
  end loop;
 end if;
 if not coalesce((public.svitlo_registry_safety(candidate)->>'approved')::boolean,false) then
  raise exception 'Registry safety review required';
 end if;
 update public.svitlo_queue_versions set active=false where active;
 insert into public.svitlo_queue_versions(id,valid_from,valid_until,checked_at,payload,active)
 values(candidate->>'id',(candidate->>'validFrom')::date,(candidate->>'validUntil')::date,
        (candidate->>'checkedAt')::bigint,clean_candidate,true)
 on conflict(id) do update set checked_at=excluded.checked_at,payload=excluded.payload,active=true;
 delete from public.svitlo_queue_rules where version_id=candidate->>'id';
 for item in select value from jsonb_array_elements(candidate->'rules') loop
  insert into public.svitlo_queue_rules(version_id,ordinal,city,street,scope,queue,evidence)
  values(candidate->>'id',n,item->>'city',item->>'street',item->>'scope',item->>'queue',item);
  n:=n+1;
 end loop;
 if changed and active_batches>0 then
  for batch_item in select value from jsonb_array_elements(reconciliation->'batches') loop
   delete from public.svitlo_address_queue_overrides
    where version_id=candidate->>'id' and batch_id=(batch_item->>'batch_id')::uuid;
   for item in select value from jsonb_array_elements(batch_item->'overrides') loop
    if exists(select 1 from public.svitlo_address_queues q
      where q.batch_id=(batch_item->>'batch_id')::uuid and q.department=item->>'department'
       and q.city_id=item->>'city_id' and q.street_id=item->>'street_id' and q.house=item->>'house'
       and q.status='service') then
     raise exception 'Cannot override a service address';
    end if;
    insert into public.svitlo_address_queue_overrides
     (version_id,batch_id,department,city_id,street_id,house,status,queue,is_estimate,confidence,evidence)
    values(candidate->>'id',(batch_item->>'batch_id')::uuid,item->>'department',item->>'city_id',
     item->>'street_id',item->>'house',item->>'status',item->>'queue',
     (item->>'is_estimate')::boolean,item->>'confidence',item->'evidence');
   end loop;
  end loop;
 end if;
end;
$function$

