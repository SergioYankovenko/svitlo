-- Private VPS evidence only; no existing profile, provider or client contracts change.
create schema svitlo_source_history authorization svitlo_region_owner;
revoke all on schema svitlo_source_history from public;
grant usage on schema svitlo_source_history to svitlo_stage_worker;
create table svitlo_source_history.cycles(
 slot bigint primary key check(slot>0 and slot%300000=0),token uuid not null,
 started_at bigint not null,finished_at bigint,lease_until bigint not null,
 state text not null check(state in ('collecting','complete','interrupted')),
 policy text not null default 'paired-history-v1',comparisons jsonb not null default '[]',analysis_error text check(analysis_error~'^[a-zA-Z0-9_]{1,80}$'),
 check(jsonb_typeof(comparisons)='array' and octet_length(comparisons::text)<=1500000)
);
create table svitlo_source_history.payloads(
 hash text primary key check(hash~'^[0-9a-f]{64}$'),source text not null,
 value jsonb not null check(jsonb_typeof(value)='object' and octet_length(value::text)<=750000),
 first_seen bigint not null,last_seen bigint not null
);
create table svitlo_source_history.observations(
 slot bigint not null references svitlo_source_history.cycles(slot) on delete cascade,
 source text not null check(source in ('dtek-kyiv','dtek-kyiv-region','yasno-kyiv')),
 started_at bigint not null,checked_at bigint not null,state text not null check(state in ('ok','error')),
 http_status integer check(http_status between 100 and 599),request_count integer not null check(request_count between 0 and 8),
 error_code text check(error_code~'^[a-zA-Z0-9_]{1,80}$'),
 payload_hash text references svitlo_source_history.payloads(hash),
 primary key(slot,source),check(checked_at>=started_at),
 check((state='ok' and payload_hash is not null and error_code is null) or (state='error' and payload_hash is null and error_code is not null))
);
create index source_history_payload_seen on svitlo_source_history.payloads(last_seen);
create index source_history_observation_payload on svitlo_source_history.observations(payload_hash);
alter table svitlo_source_history.cycles owner to svitlo_region_owner;
alter table svitlo_source_history.payloads owner to svitlo_region_owner;
alter table svitlo_source_history.observations owner to svitlo_region_owner;
alter table svitlo_source_history.cycles enable row level security;
alter table svitlo_source_history.payloads enable row level security;
alter table svitlo_source_history.observations enable row level security;

create function svitlo_source_history.claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare stamp bigint:=floor(extract(epoch from clock_timestamp())*1000);bucket bigint;proof uuid:=gen_random_uuid();begin
 bucket:=stamp-stamp%300000;
 perform pg_advisory_xact_lock(101220261104);
 update svitlo_source_history.cycles set state='interrupted',finished_at=stamp
  where state='collecting' and lease_until<stamp;
 if exists(select 1 from svitlo_source_history.cycles where slot=bucket) then return '{"granted":false}';end if;
 if exists(select 1 from svitlo_source_history.cycles where state='collecting' and lease_until>=stamp) then return '{"granted":false}';end if;
 insert into svitlo_source_history.cycles(slot,token,started_at,lease_until,state) values(bucket,proof,stamp,stamp+180000,'collecting');
 return jsonb_build_object('granted',true,'slot',bucket,'token',proof,'startedAt',stamp);
end $$;
create function svitlo_source_history.finish(bucket bigint,proof uuid,items jsonb,decisions jsonb,comparison_error text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare stamp bigint:=floor(extract(epoch from clock_timestamp())*1000);cycle svitlo_source_history.cycles;o jsonb;h text;v jsonb;begin
 select * into cycle from svitlo_source_history.cycles where slot=bucket for update;
 if not found or cycle.token<>proof then raise exception 'invalid history lease';end if;
 if cycle.state='complete' then return '{"state":"already_saved"}';end if;
 if cycle.state<>'collecting' or cycle.lease_until<stamp then raise exception 'expired history lease';end if;
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)<>3 or
    jsonb_typeof(decisions) is distinct from 'array' or jsonb_array_length(decisions)>600 or octet_length(decisions::text)>1500000 then raise exception 'invalid history bundle';end if;
 if (select count(distinct e->>'source') from jsonb_array_elements(items)e)<>3 then raise exception 'duplicate history source';end if;
 for o in select * from jsonb_array_elements(items) loop
  if (o->>'startedAt')::bigint<cycle.started_at-300000 or (o->>'checkedAt')::bigint>stamp+300000 then raise exception 'invalid observation clock';end if;
  h:=null;
  if o->>'state'='ok' then
   v:=o->'payload';if jsonb_typeof(v) is distinct from 'object' then raise exception 'missing source payload';end if;
   h:=encode(sha256(convert_to((o->>'source')||':'||v::text,'UTF8')),'hex');
   insert into svitlo_source_history.payloads values(h,o->>'source',v,stamp,stamp)
    on conflict(hash) do update set last_seen=excluded.last_seen;
  end if;
  insert into svitlo_source_history.observations values(bucket,o->>'source',(o->>'startedAt')::bigint,(o->>'checkedAt')::bigint,
   o->>'state',(o->>'httpStatus')::integer,(o->>'requestCount')::integer,o->>'errorCode',h);
 end loop;
 if exists(select 1 from jsonb_array_elements(decisions)d where jsonb_typeof(d) is distinct from 'object' or d->>'group' is null or d->>'date' is null or d->>'group' !~ '^GPV[1-9][0-9]{0,2}\.[1-9][0-9]?$' or d->>'date' !~ '^\d{4}-\d\d-\d\d$') then raise exception 'invalid comparison key';end if;
 if comparison_error is not null and jsonb_array_length(decisions)<>0 then raise exception 'invalid failed analysis';end if;
 update svitlo_source_history.cycles set state='complete',finished_at=stamp,comparisons=decisions,analysis_error=comparison_error where slot=bucket;
 return jsonb_build_object('state','saved','observations',3,'comparisons',jsonb_array_length(decisions),'analysisError',comparison_error);
end $$;

create function svitlo_source_history.cleanup() returns void language plpgsql security definer set search_path='' as $$
declare cutoff bigint:=floor(extract(epoch from clock_timestamp())*1000)-7776000000;begin
 delete from svitlo_source_history.cycles where slot in(select slot from svitlo_source_history.cycles where slot<cutoff order by slot limit 100 for update skip locked);
 delete from svitlo_source_history.payloads where hash in(select p.hash from svitlo_source_history.payloads p where p.last_seen<cutoff and not exists(select 1 from svitlo_source_history.observations o where o.payload_hash=p.hash) order by p.last_seen limit 100 for update skip locked);
end $$;
create function svitlo_source_history.timeline(first_day date,last_day date,group_key text,plan_day date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 if first_day is null or last_day is null or last_day<first_day or last_day-first_day>6 or group_key is null or group_key !~ '^GPV[1-9][0-9]{0,2}\.[1-9][0-9]?$' or plan_day is null then raise exception 'invalid history range';end if;
 select coalesce(jsonb_agg(jsonb_build_object('slot',c.slot,'startedAt',c.started_at,'finishedAt',c.finished_at,'cycleState',c.state,'analysisError',c.analysis_error,
  'observations',(select jsonb_agg(jsonb_build_object('source',o.source,'startedAt',o.started_at,'checkedAt',o.checked_at,'state',o.state,'httpStatus',o.http_status,'requestCount',o.request_count,'errorCode',o.error_code,'payloadHash',o.payload_hash) order by o.source) from svitlo_source_history.observations o where o.slot=c.slot),
  'comparison',(select d from jsonb_array_elements(c.comparisons)d where d->>'group'=group_key and d->>'date'=plan_day::text limit 1)) order by c.slot),'[]') into result
 from svitlo_source_history.cycles c where c.slot>=(extract(epoch from (first_day::timestamp at time zone 'Europe/Kyiv'))*1000)::bigint
  and c.slot<(extract(epoch from ((last_day+1)::timestamp at time zone 'Europe/Kyiv'))*1000)::bigint;
 return result;
end $$;
alter function svitlo_source_history.claim() owner to svitlo_region_owner;
alter function svitlo_source_history.finish(bigint,uuid,jsonb,jsonb,text) owner to svitlo_region_owner;
alter function svitlo_source_history.cleanup() owner to svitlo_region_owner;
alter function svitlo_source_history.timeline(date,date,text,date) owner to svitlo_region_owner;
revoke all on all functions in schema svitlo_source_history from public;
grant execute on all functions in schema svitlo_source_history to svitlo_stage_worker;
