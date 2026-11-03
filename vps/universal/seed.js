export async function seedUniversal(c){
 await c.query(`insert into svitlo_vps.operators(id,adapter_key,label,state,config) values('ua-cherkasy','cherkasy-v1','Черкасиобленерго','available','{"coverage":"Христинівська філія: перевірений каталог","unitSupported":false}') on conflict(id) do nothing`);
 await c.query(`select count(svitlo_vps.catalog_upsert('ua-cherkasy','city',jsonb_build_array(department,city_id)::text,city,null,'{}',jsonb_build_object('coverage','branch18'))) from
 (select distinct on(department,city_id) department,city_id,city from public.svitlo_effective_address_queues order by department,city_id,city) q`);
 await c.query(`select count(svitlo_vps.catalog_upsert('ua-cherkasy','street',jsonb_build_array(q.department,q.city_id,q.street_id)::text,q.street,a.entity_id,'{}','{}')) from
 (select distinct on(department,city_id,street_id) department,city_id,street_id,street from public.svitlo_effective_address_queues order by department,city_id,street_id,street) q
 join svitlo_vps.catalog_aliases a on a.operator_id='ua-cherkasy' and a.kind='city' and a.provider_key=jsonb_build_array(q.department,q.city_id)::text`);
 await c.query(`select count(svitlo_vps.catalog_upsert('ua-cherkasy','address',jsonb_build_array(q.department,q.city_id,q.street_id,q.house)::text,q.house,a.entity_id,
 jsonb_build_object('department',q.department,'cityId',q.city_id,'streetId',q.street_id,'house',q.house,'city',q.city,'street',q.street),
 jsonb_build_object('catalogStatus',q.status,'reviewedAt',q.batch->>'reviewed_at','estimated',q.is_estimate,'confidence',q.confidence)))
 from public.svitlo_effective_address_queues q join svitlo_vps.catalog_aliases a on a.operator_id='ua-cherkasy' and a.kind='street' and a.provider_key=jsonb_build_array(q.department,q.city_id,q.street_id)::text`);
 // Exact, non-destructive migration of existing staging profiles only. Unknown aliases stay untouched.
 await c.query(`update public.svitlo_profiles p set address=p.address||jsonb_build_object('canonicalAddressId',a.entity_id,'operatorId','ua-cherkasy')
 from svitlo_vps.catalog_aliases a where a.operator_id='ua-cherkasy' and a.kind='address' and not(p.address?'canonicalAddressId')
 and a.provider_key=jsonb_build_array(p.address->>'department',p.address->>'cityId',p.address->>'streetId',p.address->>'house')::text`);
 // Explicitly synthetic private staging region. Not Kyiv, not an official source.
 await seedQa(c,'qa-grid','qa-grid-v1','Тестове місто — дві лінії (синтетичні дані)');
}
export async function seedQa(c,id,adapter,label){
 await c.query(`insert into svitlo_vps.operators(id,adapter_key,label,state,is_test,config) values($1,$2,$3,'available',true,'{"coverage":"Синтетичний QA; не реальний регіон","unitSupported":true}') on conflict(id) do nothing`,[id,adapter,'Тестовий оператор '+id]);
 const upsert=async(kind,key,name,parent=null,ref={},meta={})=>(await c.query('select svitlo_vps.catalog_upsert($1,$2,$3::jsonb::text,$4,$5,$6,$7) as id',[id,kind,JSON.stringify(key),name,parent,JSON.stringify(ref),JSON.stringify(meta)])).rows[0].id;
 const city=await upsert('city',['city'],label,null,{}, {synthetic:true});
 const street=await upsert('street',['street'],'вул. Контрольна',city,{}, {district:'Північний (тест)',districtVerified:true,synthetic:true});
 const other=await upsert('street',['street-south'],'вул. Контрольна',city,{}, {district:'Південний (тест)',districtVerified:true,synthetic:true});
 for(const house of ['1','2','3','4','5','6'])await upsert('address',['house',house],house,street,{scenario:house},{synthetic:true});
 await upsert('address',['south-house','1'],'1',other,{scenario:'2'},{synthetic:true});
}
