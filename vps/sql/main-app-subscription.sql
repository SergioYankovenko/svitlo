-- SUB-01 r2, candidate only. Append after 1013; never edit an applied migration.
-- The authenticated main reader owns one grant; there are no sensor service grants.
create table svitlo_sensors.main_app_subscriptions (
 subject uuid primary key references auth.users(id) on delete cascade,
 source text not null check(source in ('verified_payment','private_test')),
 valid_from timestamptz not null,
 valid_until timestamptz not null,
 revoked_at timestamptz,
 check(valid_from<valid_until)
);
alter table svitlo_sensors.main_app_subscriptions enable row level security;
revoke all on svitlo_sensors.main_app_subscriptions from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker,svitlo_sensor_owner;
grant select on svitlo_sensors.main_app_subscriptions to svitlo_sensor_owner;
create policy sensor_read_own_subscription on svitlo_sensors.main_app_subscriptions
 for select to svitlo_sensor_owner using(subject=auth.uid());

-- Administrative grants/revocations share the mutation lock with reader claims.
-- Neither a public endpoint nor the reader's pilot key can write this table.
create function svitlo_sensors.lock_subscription_write() returns trigger
 language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.subject<>old.subject then
  raise exception 'subscription subject is immutable';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('svitlo-sub01:'||case when tg_op='DELETE' then old.subject else new.subject end::text,0));
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function svitlo_sensors.lock_subscription_write() from public;
create trigger subscription_write_lock before insert or update or delete
 on svitlo_sensors.main_app_subscriptions for each row execute function svitlo_sensors.lock_subscription_write();

create function svitlo_sensors.main_app_entitlement() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();g svitlo_sensors.main_app_subscriptions;stamp timestamptz:=clock_timestamp();active boolean;
begin
 if actor is null then return jsonb_build_object('http',401,'code','sensor_session_required');end if;
 select * into g from svitlo_sensors.main_app_subscriptions where subject=actor;
 active:=found and g.revoked_at is null and g.valid_from<=stamp and g.valid_until>stamp;
 return jsonb_build_object('http',200,'schemaVersion',1,'entitlement',jsonb_build_object(
  'policy','main_app_subscription_v1','ownerQrTransferGate',true,
  'status',case when active then 'active' else 'inactive' end,
  'validUntil',case when active then g.valid_until else null end,
  'testAccess',active and g.source='private_test',
  'maxAddresses',case when active then 10 else 2 end,'maxSensorsPerAddress',1));
end $$;
alter function svitlo_sensors.main_app_entitlement() owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.main_app_entitlement() from public;
grant execute on function svitlo_sensors.main_app_entitlement() to svitlo_stage_api;

create function svitlo_sensors.require_main_app_subscription() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();value jsonb;
begin
 if actor is null then return jsonb_build_object('http',401,'code','sensor_session_required');end if;
 -- Same order as existing phone/legacy commands, before any command receipt,
 -- reader/profile mutation or QR consumption. Revocation waits for this check.
 perform pg_advisory_xact_lock(311032106);
 perform pg_advisory_xact_lock_shared(hashtextextended('svitlo-sub01:'||actor::text,0));
 value:=svitlo_sensors.main_app_entitlement();
 if value->'entitlement'->>'status' is distinct from 'active' then
  return jsonb_build_object('http',403,'code','subscription_required');
 end if;
 return null;
end $$;
alter function svitlo_sensors.require_main_app_subscription() owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.require_main_app_subscription() from public,svitlo_stage_api,svitlo_stage_worker;

-- Keep the reviewed takeover implementation intact behind a non-public wrapper.
alter function svitlo_sensors.phone_command(text,jsonb) rename to phone_command_before_sub01;
revoke all on function svitlo_sensors.phone_command_before_sub01(text,jsonb) from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;
create function svitlo_sensors.phone_command(op text,p jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare denied jsonb;
begin
 if op='connect' then
  denied:=svitlo_sensors.require_main_app_subscription();if denied is not null then return denied;end if;
 end if;
 return svitlo_sensors.phone_command_before_sub01(op,p);
end $$;
alter function svitlo_sensors.phone_command(text,jsonb) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.phone_command(text,jsonb) from public;
grant execute on function svitlo_sensors.phone_command(text,jsonb) to svitlo_stage_api;

-- Legacy claim is another owner-entry route, not a way around the QR gate.
alter function svitlo_sensors.command(text,jsonb) rename to command_before_sub01;
revoke all on function svitlo_sensors.command_before_sub01(text,jsonb) from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;
create function svitlo_sensors.command(op text,p jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare denied jsonb;
begin
 if op='claim' then
  denied:=svitlo_sensors.require_main_app_subscription();if denied is not null then return denied;end if;
 end if;
 return svitlo_sensors.command_before_sub01(op,p);
end $$;
alter function svitlo_sensors.command(text,jsonb) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.command(text,jsonb) from public;
grant execute on function svitlo_sensors.command(text,jsonb) to svitlo_stage_api;

alter function svitlo_sensors.phone_relocate(jsonb) rename to phone_relocate_before_sub01;
revoke all on function svitlo_sensors.phone_relocate_before_sub01(jsonb) from public,anon,authenticated,svitlo_stage_api,svitlo_stage_worker;
create function svitlo_sensors.phone_relocate(p jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare denied jsonb;
begin
 denied:=svitlo_sensors.require_main_app_subscription();if denied is not null then return denied;end if;
 return svitlo_sensors.phone_relocate_before_sub01(p);
end $$;
alter function svitlo_sensors.phone_relocate(jsonb) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.phone_relocate(jsonb) from public;
grant execute on function svitlo_sensors.phone_relocate(jsonb) to svitlo_stage_api;

alter function svitlo_sensors.packet(uuid,integer,uuid) rename to packet_before_sub01;
create function svitlo_sensors.packet(sensor uuid,binding_epoch integer,subject uuid) returns jsonb
 language sql stable set search_path='' as $$
 select jsonb_set(value,'{capabilities}',value->'capabilities'||jsonb_build_object(
  'entitlement','main_app_subscription_v1','ownerQrTransferGate',true))
 from(select svitlo_sensors.packet_before_sub01($1,$2,$3) value) x
$$;
alter function svitlo_sensors.packet(uuid,integer,uuid) owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.packet(uuid,integer,uuid) from public;
