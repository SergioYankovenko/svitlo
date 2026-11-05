-- LIVE-28. Remove expired pairing secrets, never sensor identity or binding/history.
create index phone_devices_expired_qr on svitlo_sensors.phone_devices(qr_expires_at,sensor_id)
 where kind='phone' and qr_hash is not null;

create function svitlo_sensors.expired_phone_qr_cleanup() returns jsonb
language plpgsql security definer set search_path='' as $$
declare n integer;extra text:='';stamp timestamptz:=clock_timestamp();begin
 -- Compatible with the additive native-phone manual-code migration, in either order.
 if exists(select 1 from pg_catalog.pg_attribute where attrelid='svitlo_sensors.phone_devices'::regclass
  and attname='manual_code_hash' and not attisdropped) then
  extra:=',manual_code_hash=null,manual_code_cipher=null,manual_qr_hash=null';
 end if;
 -- Match get/rotate/connect lock order: device first, then its phone row. Busy pairs wait
 -- for a later tick; bounded batches do not stall onboarding or QR rotation.
 execute 'with expired as materialized (
  select p.sensor_id from svitlo_sensors.devices d join svitlo_sensors.phone_devices p using(sensor_id)
  where p.kind=''phone'' and p.qr_hash is not null and p.qr_expires_at<=$1
  order by p.qr_expires_at,p.sensor_id limit 100 for update of d,p skip locked
 ) update svitlo_sensors.phone_devices p
 set qr_hash=null,qr_cipher=null,qr_expires_at=null,qr_consumed_at=null'||extra||'
 from expired e where p.sensor_id=e.sensor_id and p.kind=''phone'' and p.qr_expires_at<=$1' using stamp;
 get diagnostics n=row_count;
 return jsonb_build_object('expiredPhoneQrSecrets',n);
end $$;
alter function svitlo_sensors.expired_phone_qr_cleanup() owner to svitlo_sensor_owner;
revoke all on function svitlo_sensors.expired_phone_qr_cleanup() from public,anon,authenticated,svitlo_stage_api;
grant execute on function svitlo_sensors.expired_phone_qr_cleanup() to svitlo_stage_worker;
