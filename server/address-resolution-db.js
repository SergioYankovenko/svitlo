// Service-only adapter. A catalog miss remains distinct from an explicit exclusion.
export async function addressResolutionData(db,address) {
  if(!address||['department','cityId','streetId','house'].some(k=>typeof address[k]!=='string'||!address[k]||address[k].length>120))
    return {record:null,registry:null};
  return db.result(db.c.rpc('svitlo_address_resolution_data',{
    department_id:address.department,city_id:address.cityId,street_id:address.streetId,house_number:address.house,
  }));
}
