-- Optional licensed auxiliary API. Disabled until a server key and reviewed
-- exact mappings exist. It cannot allocate houses or overwrite official IDs.
create table svitlo_sources.external_mappings(
 address_id uuid primary key references svitlo_vps.catalog(id),operator_id text not null,area_slug text not null check(area_slug~'^[a-z0-9-]{1,80}$'),
 initiator text not null check(length(initiator) between 1 and 80),groups jsonb not null check(jsonb_typeof(groups)='array' and jsonb_array_length(groups) between 1 and 32),
 complete boolean not null default false,reviewed boolean not null default false,source_reference text not null check(length(source_reference) between 8 and 500),
 valid_from timestamptz not null,valid_until timestamptz,check(valid_until is null or valid_until>valid_from)
);
create table svitlo_sources.external_quota(id boolean primary key default true check(id),enabled boolean not null default false,quota_day date,requests integer not null default 0,next_at timestamptz not null default '-infinity',cooldown_until timestamptz not null default '-infinity');
insert into svitlo_sources.external_quota(id) values(true);
alter table svitlo_sources.external_mappings owner to svitlo_sources_owner;alter table svitlo_sources.external_quota owner to svitlo_sources_owner;
revoke all on svitlo_sources.external_mappings,svitlo_sources.external_quota from public,svitlo_stage_api,svitlo_stage_worker;
grant usage on schema svitlo_vps to svitlo_sources_owner;grant select(id,kind,operator_id) on svitlo_vps.catalog to svitlo_sources_owner;
create function svitlo_sources.external_mapping(address uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select to_jsonb(m)-'address_id' from svitlo_sources.external_mappings m join svitlo_vps.catalog c on c.id=m.address_id where m.address_id=address and c.kind='address' and c.operator_id=m.operator_id and m.reviewed and m.valid_from<=clock_timestamp() and (m.valid_until is null or m.valid_until>clock_timestamp())
$$;
create function svitlo_sources.external_acquire() returns jsonb language plpgsql security definer set search_path='' as $$
declare q svitlo_sources.external_quota;stamp timestamptz:=clock_timestamp();today date:=(clock_timestamp() at time zone 'Europe/Kyiv')::date;begin
 select * into q from svitlo_sources.external_quota where id for update;
 if not q.enabled then return '{"granted":false,"code":"alerts_not_configured"}';end if;
 if q.quota_day is distinct from today then q.requests:=0;end if;
 if q.requests>=10000 then return '{"granted":false,"code":"daily_quota_exceeded"}';end if;
 if q.cooldown_until>stamp then return jsonb_build_object('granted',false,'code','rate_limited','waitMs',ceil(extract(epoch from q.cooldown_until-stamp)*1000));end if;
 if q.next_at>stamp then return jsonb_build_object('granted',false,'code','busy','waitMs',ceil(extract(epoch from q.next_at-stamp)*1000));end if;
 update svitlo_sources.external_quota set quota_day=today,requests=q.requests+1,next_at=stamp+interval '200 milliseconds' where id;return '{"granted":true}';
end $$;
create function svitlo_sources.external_cooldown(seconds integer) returns void language plpgsql security definer set search_path='' as $$begin
 update svitlo_sources.external_quota set cooldown_until=greatest(cooldown_until,clock_timestamp()+make_interval(secs=>greatest(1,least(86400,seconds)))) where id;
end $$;
do $$ declare f text;begin foreach f in array array['external_mapping(uuid)','external_acquire()','external_cooldown(integer)'] loop execute 'alter function svitlo_sources.'||f||' owner to svitlo_sources_owner';execute 'revoke all on function svitlo_sources.'||f||' from public';execute 'grant execute on function svitlo_sources.'||f||' to svitlo_stage_api,svitlo_stage_worker';end loop;end $$;
