-- Public diagnostic providers only. No existing catalogue/profile/line mutation.
insert into svitlo_vps.operators(id,adapter_key,label,state,config) values
 ('ua-chernihiv','discovery-public-v1','Чернігівобленерго','degraded','{"collectorOnly":true}'),
 ('ua-sumy','discovery-public-v1','Сумиобленерго','degraded','{"collectorOnly":true}'),
 ('ua-poltava','discovery-public-v1','Полтаваобленерго','degraded','{"collectorOnly":true}'),
 ('ua-kharkiv','discovery-public-v1','Харківобленерго','degraded','{"collectorOnly":true}'),
 ('ua-kirovohrad','discovery-public-v1','Кіровоградобленерго','degraded','{"collectorOnly":true}'),
 ('ua-dnipro-dtek','discovery-public-v1','ДТЕК Дніпровські електромережі','degraded','{"collectorOnly":true}'),
 ('ua-zaporizhzhia','discovery-public-v1','Запоріжжяобленерго','degraded','{"collectorOnly":true}'),
 ('ua-donetsk-dtek','discovery-public-v1','ДТЕК Донецькі електромережі','degraded','{"collectorOnly":true}')
on conflict(id) do nothing;
do $$ begin
 if exists(select 1 from svitlo_vps.operators where id in ('ua-chernihiv','ua-sumy','ua-poltava','ua-kharkiv','ua-kirovohrad','ua-dnipro-dtek','ua-zaporizhzhia','ua-donetsk-dtek') and (adapter_key<>'discovery-public-v1' or config->>'collectorOnly' is distinct from 'true')) then raise exception 'Collector operator identity collision';end if;
end $$;
create table svitlo_discovery.regional_sources(
 operator_id text primary key references svitlo_vps.operators(id),
 region_code text not null references svitlo_geo.places(code),source_url text not null check(source_url like 'https://%'),
 enabled boolean not null default true,status text not null default 'pending' check(status in ('pending','partial','available','unavailable','forbidden','invalid_source','needs_feed')),
 directory_complete boolean not null default false,last_attempt_at timestamptz,last_success_at timestamptz,next_at timestamptz not null default now(),
 checkpoint jsonb not null default '{}' check(jsonb_typeof(checkpoint)='object' and pg_column_size(checkpoint)<40000),
 summary jsonb not null default '{}' check(jsonb_typeof(summary)='object' and pg_column_size(summary)<4000),
 error_code text check(error_code is null or error_code~'^[a-z0-9_]{1,64}$')
);
alter table svitlo_discovery.regional_sources owner to svitlo_discovery_owner;
alter table svitlo_discovery.regional_sources enable row level security;
revoke all on svitlo_discovery.regional_sources from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;
create index discovery_regional_refresh_due on svitlo_discovery.regional_sources(next_at,operator_id) where enabled;
insert into svitlo_discovery.regional_sources(operator_id,region_code,source_url)
 select v.op,p.code,v.url from (values
 ('ua-chernihiv','UA74','https://chernihivoblenergo.com.ua/blackouts'),
 ('ua-sumy','UA59','https://www.soe.com.ua/consumers/shutdowns'),
 ('ua-poltava','UA53','https://www.poe.pl.ua/disconnection/power-outages/'),
 ('ua-kharkiv','UA63','https://oblenergo.kharkiv.ua/uk/gaoinfo'),
 ('ua-kirovohrad','UA35','https://kiroe.com.ua/electricity-blackout'),
 ('ua-dnipro-dtek','UA12','https://www.dtek-dnem.com.ua/ua/shutdowns'),
 ('ua-zaporizhzhia','UA23','https://www.zoe.com.ua/outage/'),
 ('ua-donetsk-dtek','UA14','https://www.dtek-dem.com.ua/ua/shutdowns')) v(op,prefix,url)
 join svitlo_geo.places p on p.level=1 and p.code like v.prefix||'%' and p.active;
-- A fresh database imports its KATOTTG bundle after DDL. The owner initializer
-- fills these rows then; an existing directory must already reconcile all eight.
do $$ begin if exists(select 1 from svitlo_geo.places) and (select count(*) from svitlo_discovery.regional_sources)<>8 then raise exception 'Regional source KATOTTG mapping failed';end if;end $$;
insert into svitlo_discovery.operator_turn(operator_id) select operator_id from svitlo_discovery.regional_sources on conflict do nothing;

-- Reuse the same bounded shared transport as interactive sources. No host URLs,
-- account payloads, session tickets or private credentials enter configuration.
alter table svitlo_regions.provider_state drop constraint if exists provider_state_operator_check;
alter table svitlo_regions.provider_state add constraint provider_state_operator_check check(operator in (
 'ua-kyiv-dtek','ua-kyiv-region-dtek','yasno-kyiv','ua-chernihiv','ua-sumy','ua-poltava','ua-kharkiv','ua-kirovohrad','ua-dnipro-dtek','ua-zaporizhzhia','ua-donetsk-dtek'));
grant usage on schema svitlo_discovery to svitlo_region_owner;
grant select(operator_id,enabled) on svitlo_discovery.regional_sources to svitlo_region_owner;
create policy regional_transport_configuration on svitlo_discovery.regional_sources for select to svitlo_region_owner using(true);
create or replace function svitlo_regions.acquire(op text) returns jsonb language plpgsql security definer set search_path='' as $$
declare quota svitlo_regions.provider_state;stamp bigint:=floor(extract(epoch from clock_timestamp())*1000);proof uuid;begin
 if op not in ('ua-kyiv-dtek','ua-kyiv-region-dtek','yasno-kyiv') and not exists(select 1 from svitlo_discovery.regional_sources s where s.operator_id=op and s.enabled) then raise exception 'invalid operator budget';end if;
 insert into svitlo_regions.provider_state(operator) values(op) on conflict do nothing;
 select * into quota from svitlo_regions.provider_state where operator=op for update;
 if quota.cooldown_until>stamp then return jsonb_build_object('granted',false,'reason','cooldown','code',coalesce(quota.last_code,'rate_limited'),'waitMs',quota.cooldown_until-stamp);end if;
 if quota.lease_until>stamp or quota.next_at>stamp then return jsonb_build_object('granted',false,'reason','busy','waitMs',greatest(50,least(500,greatest(quota.lease_until,quota.next_at)-stamp)));end if;
 if stamp>=quota.window_at+60000 then quota.window_at:=stamp;quota.requests:=0;end if;
 if quota.requests>=30 then return jsonb_build_object('granted',false,'reason','cooldown','code','rate_limited','waitMs',quota.window_at+60000-stamp);end if;
 proof:=gen_random_uuid();update svitlo_regions.provider_state set ticket=proof,lease_until=stamp+12000,next_at=stamp+1000,window_at=quota.window_at,requests=quota.requests+1 where operator=op;
 return jsonb_build_object('granted',true,'ticket',proof);
end $$;
alter function svitlo_regions.acquire(text) owner to svitlo_region_owner;
revoke all on function svitlo_regions.acquire(text) from public;
grant execute on function svitlo_regions.acquire(text) to svitlo_stage_api,svitlo_stage_worker;
grant select(window_at,requests) on svitlo_regions.provider_state to svitlo_discovery_owner;
alter policy discovery_transport_deadline on svitlo_regions.provider_state using(operator in (
 'ua-kyiv-dtek','ua-kyiv-region-dtek','ua-chernihiv','ua-sumy','ua-poltava','ua-kharkiv','ua-kirovohrad','ua-dnipro-dtek','ua-zaporizhzhia','ua-donetsk-dtek'));
create or replace function svitlo_discovery.source_available_at(op text) returns timestamptz language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from svitlo_discovery.regional_sources where operator_id=op and not enabled) then 'infinity'::timestamptz
 when op='ua-cherkasy' then coalesce((select to_timestamp(greatest(h.next_start,h.cooldown_until)/1000.0) from public.svitlo_provider_hosts h where h.host='cabinet.cherkasyoblenergo.com'),'-infinity'::timestamptz)
 when op in ('ua-kyiv-dtek','ua-kyiv-region-dtek') or exists(select 1 from svitlo_discovery.regional_sources where operator_id=op and enabled)
 then coalesce((select to_timestamp(greatest(p.next_at,p.lease_until,p.cooldown_until,case when p.requests>=30 then p.window_at+60000 else 0 end)/1000.0) from svitlo_regions.provider_state p where p.operator=op),'-infinity'::timestamptz)
 else '-infinity'::timestamptz end
$$;
alter function svitlo_discovery.source_available_at(text) owner to svitlo_discovery_owner;
revoke all on function svitlo_discovery.source_available_at(text) from public,svitlo_stage_api,svitlo_stage_worker;
