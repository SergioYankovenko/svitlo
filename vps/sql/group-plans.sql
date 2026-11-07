-- One supplemental publication per existing five-minute collection cycle.
create index source_history_latest_source on svitlo_source_history.observations(source,slot desc);
create table svitlo_source_history.cherkasy_group_plans(
 slot bigint primary key references svitlo_source_history.cycles(slot) on delete cascade,
 value jsonb check(value is null or jsonb_typeof(value)='object' and octet_length(value::text)<=500000),
 error text check(error is null or error~'^[a-z0-9_]{1,80}$'),
 check(value is not null or error is not null)
);
alter table svitlo_source_history.cherkasy_group_plans owner to svitlo_region_owner;
alter table svitlo_source_history.cherkasy_group_plans enable row level security;

create function svitlo_source_history.finish_group_cycle(bucket bigint,proof uuid,items jsonb,decisions jsonb,comparison_error text,cherkasy jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt jsonb;begin
 receipt:=svitlo_source_history.finish(bucket,proof,items,decisions,comparison_error);
 if receipt->>'state'='saved' then
  insert into svitlo_source_history.cherkasy_group_plans(slot,value,error) values(bucket,cherkasy->'value',cherkasy->>'error');
 end if;
 return receipt;
end $$;
alter function svitlo_source_history.finish_group_cycle(bigint,uuid,jsonb,jsonb,text,jsonb) owner to svitlo_region_owner;
revoke all on function svitlo_source_history.finish_group_cycle(bigint,uuid,jsonb,jsonb,text,jsonb) from public;
grant execute on function svitlo_source_history.finish_group_cycle(bigint,uuid,jsonb,jsonb,text,jsonb) to svitlo_stage_worker;

create function svitlo_source_history.group_plan(source_key text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 if source_key='cherkasy' then
  select jsonb_build_object('slot',latest.slot,'error',latest.error,'value',prior.value) into result
   from (select slot,error from svitlo_source_history.cherkasy_group_plans order by slot desc limit 1) latest
   left join lateral (select value from svitlo_source_history.cherkasy_group_plans where value is not null and slot>=latest.slot-3600000 order by slot desc limit 1) prior on true;
 elsif source_key in ('dtek-kyiv','dtek-kyiv-region','yasno-kyiv') then
  select jsonb_build_object('slot',latest.slot,'error',latest.error_code,'checkedAt',prior.checked_at,
    'value',case when source_key='yasno-kyiv' then payload.value->'parsed'
     else jsonb_build_object('fact',payload.value#>'{parsed,fact}','flags',payload.value#>'{parsed,flags}') end) into result
   from (select slot,error_code from svitlo_source_history.observations where source=source_key order by slot desc limit 1) latest
   left join lateral (select checked_at,payload_hash from svitlo_source_history.observations where source=source_key and state='ok'
    and slot>=latest.slot-3600000 order by slot desc limit 1) prior on true
   left join svitlo_source_history.payloads payload on payload.hash=prior.payload_hash;
 else raise exception 'unsupported group plan source';
 end if;
 return result;
end $$;
alter function svitlo_source_history.group_plan(text) owner to svitlo_region_owner;
revoke all on function svitlo_source_history.group_plan(text) from public;
grant execute on function svitlo_source_history.group_plan(text) to svitlo_stage_api,svitlo_stage_worker;
