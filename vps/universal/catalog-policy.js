// Administrative import policy; no name-based street/house merges.
export async function seedCatalogPolicy(c){
 const city=(await c.query("select entity_id from svitlo_vps.catalog_aliases where operator_id='ua-cherkasy' and kind='city' and provider_key='[\"18\", \"801\"]'")).rows[0];
 if(city)await c.query("select svitlo_vps.catalog_link_city('ua-cherkasy','[\"3\", \"100\"]',$1,'{\"reference\":\"BE-01: user-confirmed city routes 18/801 = 3/100; prototype source snapshot\",\"scope\":\"identity-only; branch3 catalog not imported\"}')",[city.entity_id]);
 // Positive evidence only: an imported usable street proves availability, never completeness.
 // Use original source reviewed_at, so re-seeding an old snapshot cannot undo a newer empty verification.
 const routes=await c.query(`select a.operator_id,a.provider_key,a.entity_id,min((q.batch->>'reviewed_at')::timestamptz) checked
 from svitlo_vps.catalog_aliases a join public.svitlo_effective_address_queues q on a.operator_id='ua-cherkasy' and a.kind='city' and a.provider_key=jsonb_build_array(q.department,q.city_id)::text
 join svitlo_vps.catalog_aliases s on s.operator_id=a.operator_id and s.kind='street' and s.provider_key=jsonb_build_array(q.department,q.city_id,q.street_id)::text
 where svitlo_vps.catalog_allowed(s.entity_id) group by a.operator_id,a.provider_key,a.entity_id`);
 for(const r of routes.rows)await c.query("select svitlo_vps.catalog_route_state($1,$2,$3,'available',false,$4,'{\"reference\":\"verified public branch18 import; at least one usable street\",\"completeSnapshot\":false}')",[r.operator_id,r.provider_key,r.entity_id,r.checked]);
}
