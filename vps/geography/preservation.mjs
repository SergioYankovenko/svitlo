// Owner-side hashes only: no subject, address, push token, QR or ingest secret is returned.
export async function preservation(c){
 const tables=['public.svitlo_profiles','public.svitlo_subscriptions','svitlo_vps.catalog','svitlo_vps.catalog_aliases','svitlo_vps.city_routes','svitlo_vps.address_lines','svitlo_vps.catalog_exclusions',
  'svitlo_sensors.devices','svitlo_sensors.bindings','svitlo_sensors.memberships','svitlo_sensors.reader_links','svitlo_sensors.invitations','svitlo_sensors.main_app_subscriptions','svitlo_sensors.phone_devices','svitlo_sensors.phone_streams','svitlo_sensors.phone_ranges'];
 const result={};
 for(const table of tables){
  if(!(await c.query('select to_regclass($1) present',[table])).rows[0].present)continue;
  // These identifiers are fixed source constants, never request data.
  result[table]=(await c.query(`select count(*)::int count,md5(coalesce(string_agg(h,'|' order by h),'')) digest from(select md5(to_jsonb(t)::text) h from ${table} t) x`)).rows[0];
 }
 result.migrations=(await c.query('select name,sha256 from svitlo_vps.migrations order by name')).rows;
 result.releaseState=(await c.query('select * from svitlo_vps.release_state')).rows;
 return result;
}
