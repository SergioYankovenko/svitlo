-- Separate operator-controlled collection, independent of the public map flag.
alter table svitlo_charging.control add column collector_enabled boolean not null default false;
alter table svitlo_charging.stations add column refresh_scheduled_at timestamptz;
update svitlo_charging.providers set license_text='CC BY-SA 4.0',attribution_name='Open Charge Map Contributors',
 license_url='https://creativecommons.org/licenses/by-sa/4.0/' where id='ocm' and not reviewed;
grant usage on schema svitlo_events to svitlo_charging_owner;
grant execute on function svitlo_events.publish(text,text,bigint,jsonb,timestamptz,integer) to svitlo_charging_owner;
create function svitlo_charging.collection_allowed() returns boolean
language sql stable security definer set search_path='' as $$
 select c.collector_enabled and exists(select from svitlo_charging.providers where id='ocm' and reviewed)
 from svitlo_charging.control c where c.id
$$;
create function svitlo_charging.enqueue_refresh() returns integer
language plpgsql security definer set search_path='' as $$
declare candidate record;n integer:=0;cycle bigint:=floor(extract(epoch from clock_timestamp())/21600);begin
 if not svitlo_charging.collection_allowed() then return 0;end if;
 if not pg_try_advisory_xact_lock(hashtextextended('charging-catalog-refresh-v1',0)) then return 0;end if;
 for candidate in select id from svitlo_charging.stations where active and collected_at<clock_timestamp()-interval '6 hours'
  and (refresh_scheduled_at is null or refresh_scheduled_at<to_timestamp(cycle*21600)) order by collected_at,id limit 1 loop
  perform svitlo_events.publish('charging.refresh.v1',candidate.id,cycle,jsonb_build_object('stationId',candidate.id),clock_timestamp()+interval '2 hours',1);
  update svitlo_charging.stations set refresh_scheduled_at=clock_timestamp() where id=candidate.id;
  n:=n+1;
 end loop;return n;
end $$;
create function svitlo_charging.apply_refresh(items jsonb) returns integer
language plpgsql security definer set search_path='' as $$begin
 perform 1 from svitlo_charging.control where id for share;
 if not svitlo_charging.collection_allowed() then raise exception 'charging collection disabled';end if;
 return svitlo_charging.import_catalog(items);
end $$;
alter function svitlo_charging.collection_allowed() owner to svitlo_charging_owner;
alter function svitlo_charging.enqueue_refresh() owner to svitlo_charging_owner;
alter function svitlo_charging.apply_refresh(jsonb) owner to svitlo_charging_owner;
revoke all on function svitlo_charging.collection_allowed(),svitlo_charging.enqueue_refresh(),svitlo_charging.apply_refresh(jsonb) from public;
revoke execute on function svitlo_charging.import_catalog(jsonb) from svitlo_stage_worker;
grant execute on function svitlo_charging.collection_allowed(),svitlo_charging.enqueue_refresh(),svitlo_charging.apply_refresh(jsonb) to svitlo_stage_worker;
