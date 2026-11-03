import {createHmac,timingSafeEqual} from 'node:crypto';
import {inputAddress,normalHouse,normalName,mapError} from './policy.js';
import {VisicomConnector} from './connector.js';
export function mapOnlySnapshot(address,old={}){
 return {...old,mapOnly:true,mapLocation:address.mapLocation,providerAvailable:false,queue:null,queueResolution:{status:'not_found',reason:'provider_address_not_found'},plans:[],emergencies:[],
  categories:Object.fromEntries(['hourly','planned','emergency'].map(k=>[k,{events:[],checkedAt:0,sourceAt:0}])),checkedAt:0,feedCheckedAt:0,feedFailed:false,failures:[]};
}
export class MapAddresses {
 constructor({bridge,catalog,secret,connector=new VisicomConnector(),now=Date.now}){Object.assign(this,{bridge,catalog,secret,connector,now});}
 mac(value){return createHmac('sha256',this.secret).update('visicom-address-v1:'+value).digest('base64url');}
 token(owner,input,location){const body=Buffer.from(JSON.stringify({owner,input,location,expiresAt:this.now()+600000})).toString('base64url');return body+'.'+this.mac(body);}
 open(owner,token){
  if(typeof token!=='string'||token.length>5000)throw mapError('map_expired',409);
  const parts=token.split('.');if(parts.length!==2||!/^[-_A-Za-z0-9]+$/.test(parts[0])||!/^[-_A-Za-z0-9]{43}$/.test(parts[1])||!timingSafeEqual(Buffer.from(parts[1]),Buffer.from(this.mac(parts[0]))))throw mapError('map_expired',409);
  let p;try{p=JSON.parse(Buffer.from(parts[0],'base64url'));}catch{throw mapError('map_expired',409);}
  if(p.owner!==owner||p.expiresAt<=this.now()||p.expiresAt>this.now()+600000)throw mapError('map_expired',409);inputAddress(p.input);return p;
 }
 async context(input){
  const city=await this.catalog.entity(input.cityId);if(city.kind!=='city'||city.metadata?.synthetic)throw mapError('map_invalid_input',400);
  if(input.streetId){const street=await this.catalog.entity(input.streetId);if(street.kind!=='street'||street.parent_id!==city.id)throw mapError('map_invalid_input',400);input.street=street.label;}
  const routes=(await this.bridge.query("select operator_id,provider_key,state from svitlo_vps.city_routes where city_id=$1",[city.id])).rows;
  if(!routes.some(r=>r.operator_id==='ua-cherkasy'&&r.state==='available'))throw mapError('map_unavailable');
  const type=/^(?:с\.|село)\s*/iu.test(city.label)?'село':/^(?:м\.|місто)\s*/iu.test(city.label)?'місто':undefined;
  const name=city.label.replace(/^(?:м\.|місто|с\.|село|смт\.?|селище)\s*/iu,'').trim();
  const known=routes.some(r=>r.operator_id==='ua-cherkasy'&&['["18", "801"]','["3", "100"]'].includes(r.provider_key));
  return {id:city.id,name,region:'Черкаська область',...(type?{type}:{}),...(known?{settlementId:'STL1NYKCD',type:'місто'}:{})};
 }
 async providerAddress(input){
  const rows=(await this.bridge.query(`select a.id,a.label,s.label street,s.id street_id from svitlo_vps.catalog a join svitlo_vps.catalog s on s.id=a.parent_id
   where a.kind='address' and s.parent_id=$1 and a.operator_id<>'map-only' and svitlo_vps.catalog_allowed(a.id)
   and ($2::uuid is null or s.id=$2::uuid) and lower(regexp_replace(a.label,'[[:space:]]','','g'))=lower(regexp_replace($3,'[[:space:]]','','g'))`,[input.cityId,input.streetId||null,input.house])).rows;
  const matches=rows.filter(r=>input.streetId||normalName(r.street)===normalName(input.street));
  return matches.length===1?matches[0]:null;
 }
 async search(owner,packet){
  const input=inputAddress(packet),city=await this.context(input);
  const existing=await this.providerAddress(input);if(existing)return {schemaVersion:1,state:'provider_found',addressId:existing.id,candidates:[]};
  if(!(await this.bridge.query('select svitlo_maps.take_budget() allowed')).rows[0].allowed)throw mapError('map_rate_limited',429);
  const locations=await this.connector.lookup(input,city);
  return {schemaVersion:1,state:locations.length?'found':'not_found',input:{city:city.name,street:input.street,house:input.house},candidates:locations.map(location=>({label:location.label,precision:location.precision,matchedHouse:location.matchedHouse,url:location.url,token:this.token(owner,input,location)}))};
 }
 async save(owner,token,name,preferences){
  const proof=this.open(owner,token),input=proof.input,city=await this.context(input);
  if(await this.providerAddress(input))throw Object.assign(mapError('map_expired',409),{message:'Адреса вже з’явилась у довіднику. Повторіть пошук.'});
  const location=proof.location;
  const hash=s=>createHmac('sha256',this.secret).update(s).digest('hex');
  const streetKey=hash(JSON.stringify(['map-street',city.id,location.streetId]));
  const addressKey=hash(JSON.stringify(['map-address',city.id,location.streetId,normalHouse(input.house)]));
  const address={mapOnly:true,operatorId:'map-only',department:'map:visicom',cityId:city.id,city:city.name,street:input.street,house:input.house,lineId:null,
   label:`${city.name}, ${input.street}, ${input.house}`,mapLocation:location};
  return (await this.bridge.query('select svitlo_maps.create_profile($1,$2,$3::jsonb,$4,$5::jsonb) result',[streetKey,addressKey,JSON.stringify(address),name||'',JSON.stringify(preferences)])).rows[0].result;
 }
}
