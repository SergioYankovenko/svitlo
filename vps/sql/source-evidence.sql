do $$ begin if not exists(select from pg_roles where rolname='svitlo_sources_owner') then create role svitlo_sources_owner nologin nobypassrls;end if;end $$;
create schema svitlo_sources authorization svitlo_sources_owner;
revoke all on schema svitlo_sources from public;
create table svitlo_sources.registry(id text primary key,operator_id text not null,label text not null,schedule_url text not null,family text not null,parser_version text not null,verification_state text not null,metadata jsonb not null default '{}');
create table svitlo_sources.state(source_id text primary key references svitlo_sources.registry(id),last_attempt_at timestamptz,last_fetch_at timestamptz,last_success_at timestamptz,last_error_at timestamptz,last_outcome text);
create table svitlo_sources.evidence(id bigint generated always as identity primary key,source_id text not null references svitlo_sources.registry(id),phase text not null,outcome text not null,content_hash text,status integer not null,bytes bigint not null,parser_version text not null,first_seen_at timestamptz not null,last_seen_at timestamptz not null,observations bigint not null default 1);
create unique index source_evidence_fingerprint on svitlo_sources.evidence(source_id,phase,(coalesce(content_hash,'failure')),outcome,parser_version);
create index source_evidence_cleanup on svitlo_sources.evidence(last_seen_at);
do $$ declare t text;begin foreach t in array array['registry','state','evidence'] loop execute 'alter table svitlo_sources.'||t||' owner to svitlo_sources_owner';execute 'revoke all on svitlo_sources.'||t||' from public,svitlo_stage_api,svitlo_stage_worker,svitlo_stage_session';end loop;end $$;
create function svitlo_sources.record(data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare sid text:=data->>'sourceId';p_phase text:=data->>'phase';p_outcome text:=data->>'outcome';hash text:=data->>'contentHash';stamp timestamptz;checked timestamptz;begin
 if not exists(select from svitlo_sources.registry where id=sid) or p_phase not in ('fetch','parse','normalize')
  or p_outcome not in ('observed','accepted','partial','invalid','forbidden','rate_limited','timeout','unavailable')
  or hash is not null and hash!~'^[a-f0-9]{64}$' or length(data->>'parserVersion') not between 1 and 80
  or (data->>'status')::integer not between 0 and 599 or (data->>'bytes')::bigint not between 0 and 100000000 then raise exception 'invalid source evidence';end if;
 stamp:=to_timestamp((data->>'observedAt')::double precision/1000);
 if stamp is null or stamp>clock_timestamp()+interval '5 minutes' then raise exception 'invalid source clock';end if;
 if data ? 'checkedAt' then checked:=to_timestamp((data->>'checkedAt')::double precision/1000);if checked>stamp+interval '5 minutes' then raise exception 'invalid evidence clock';end if;end if;
 insert into svitlo_sources.evidence(source_id,phase,outcome,content_hash,status,bytes,parser_version,first_seen_at,last_seen_at)
 values(sid,p_phase,p_outcome,hash,(data->>'status')::integer,(data->>'bytes')::bigint,data->>'parserVersion',stamp,stamp)
 on conflict(source_id,phase,(coalesce(content_hash,'failure')),outcome,parser_version) do update set last_seen_at=greatest(svitlo_sources.evidence.last_seen_at,excluded.last_seen_at),observations=svitlo_sources.evidence.observations+1;
 insert into svitlo_sources.state(source_id,last_attempt_at,last_fetch_at,last_success_at,last_error_at,last_outcome)
 values(sid,stamp,case when p_phase='fetch' and p_outcome='observed' then stamp end,case when p_phase='normalize' and p_outcome='accepted' then checked end,case when p_outcome in ('invalid','forbidden','rate_limited','timeout','unavailable') then stamp end,p_outcome)
 on conflict(source_id) do update set last_attempt_at=greatest(svitlo_sources.state.last_attempt_at,excluded.last_attempt_at),last_fetch_at=greatest(svitlo_sources.state.last_fetch_at,excluded.last_fetch_at),last_success_at=greatest(svitlo_sources.state.last_success_at,excluded.last_success_at),last_error_at=greatest(svitlo_sources.state.last_error_at,excluded.last_error_at),last_outcome=excluded.last_outcome;
end $$;
alter function svitlo_sources.record(jsonb) owner to svitlo_sources_owner;
revoke all on function svitlo_sources.record(jsonb) from public;
grant usage on schema svitlo_sources to svitlo_stage_api,svitlo_stage_worker;
grant execute on function svitlo_sources.record(jsonb) to svitlo_stage_api,svitlo_stage_worker;
create function svitlo_sources.cleanup() returns integer language plpgsql security definer set search_path='' as $$
declare n integer;begin delete from svitlo_sources.evidence where id in(select id from svitlo_sources.evidence where last_seen_at<clock_timestamp()-interval '90 days' order by last_seen_at limit 1000 for update skip locked);get diagnostics n=row_count;return n;end $$;
alter function svitlo_sources.cleanup() owner to svitlo_sources_owner;revoke all on function svitlo_sources.cleanup() from public;grant execute on function svitlo_sources.cleanup() to svitlo_stage_worker;
