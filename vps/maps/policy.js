export const mapError=(code,status=503)=>Object.assign(Error({map_unavailable:'Пошук на карті тимчасово недоступний',map_expired:'Повторіть пошук адреси на карті',map_invalid_input:'Перевірте вулицю й номер будинку',map_rate_limited:'Зачекайте перед наступним пошуком'}[code]||'Не вдалося перевірити адресу на карті'),{code,status});
export const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
export const text=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/[\u0000-\u001f\u007f]/u.test(s);
export const normalHouse=s=>s.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/\s/g,'').replace(/^(\d+)\/([а-яіїєґa-z])$/u,'$1$2');
export const normalName=s=>s.normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[’ʼ`]/g,"'").replace(/^(?:вулиця|вул\.?|місто|м\.|село|с\.|селище|смт\.?)\s*/u,'').replace(/[.\s]/g,'');
export function inputAddress(p){
 if(!p||!uuid(p.cityId)||!text(p.street,160)||!text(p.house,80)||p.streetId!==undefined&&!uuid(p.streetId))throw mapError('map_invalid_input',400);
 return {cityId:p.cityId.toLowerCase(),...(p.streetId?{streetId:p.streetId.toLowerCase()}:{}),street:p.street,house:p.house};
}
function roadType(s){return /^(?:пров\.?|провулок)(?:\s|$)/iu.test(s.trim())?'lane':'street';}
export function streetRelation(a,b,settlementId){
 if(roadType(a)!==roadType(b))return null;
 const left=normalName(a),right=normalName(b);
 if(left===right)return 'same';
 if(settlementId==='STL1NYKCD'&&left==='першотравнева'&&right==='травнева')return 'documented_rename';
 const words=s=>s.toLocaleLowerCase('uk-UA').replace(/^(?:вулиця|вул\.?)\s*/u,'').trim().split(/[.\s]+/u).filter(Boolean);
 const x=words(a),y=words(b);
 if(x.length===2&&y.length===2&&x[1]===y[1]&&(x[0].length===1&&y[0].startsWith(x[0])||y[0].length===1&&x[0].startsWith(y[0])))return 'initial';
 return null;
}
export function features(data){
 if(data?.type==='Feature'&&data.properties)return [data];
 if(data?.type==='FeatureCollection'&&Array.isArray(data.features))return data.features;
 if(data&&typeof data==='object'&&!Array.isArray(data)&&!Object.keys(data).length)return [];
 throw mapError('map_unavailable');
}
export function candidates(data,input,city){
 const result=new Map();
 for(const f of features(data)){
  const p=f.properties||{},sourceStreet=p.street??p.name,kind=p.street_type??p.type??'вул.';
  if(p.country_code!=='ua'||normalName(p.settlement||'')!==normalName(city.name)||city.settlementId&&p.settlement_id!==city.settlementId||city.type&&p.settlement_type!==city.type)continue;
  if(!['adr_address','adr_street'].includes(p.categories)||!text(sourceStreet,160)||!/^STL[A-Z0-9]+$/.test(p.settlement_id||''))continue;
  const relation=streetRelation(input.street,`${kind} ${sourceStreet}`,p.settlement_id);if(!relation)continue;
  const isHouse=p.categories==='adr_address'&&normalHouse(p.name)===normalHouse(input.house);
  const streetId=p.categories==='adr_street'?f.id:p.street_id;
  const id=isHouse?f.id:streetId;
  if(!/^(?:ADR|STR)[A-Z0-9]{4,80}$/.test(id||'')||!/^STR[A-Z0-9]{4,80}$/.test(streetId||''))continue;
  const candidate={featureId:id,streetId,settlementId:p.settlement_id,street:sourceStreet,streetType:kind,matchedHouse:isHouse?p.name:null,precision:isHouse?'house':'street',relation};
  result.set(`${streetId}:${isHouse?normalHouse(p.name):'street'}`,candidate);
 }
 const list=[...result.values()];return list.sort((a,b)=>(a.precision==='house'?0:1)-(b.precision==='house'?0:1)).slice(0,3);
}
export function finalCandidate(data,candidate,input,city,now){
 const p=data?.properties||{};
 if(data?.id!==candidate.featureId||p.country_code!=='ua'||p.settlement_id!==candidate.settlementId||normalName(p.settlement||'')!==normalName(city.name))throw mapError('map_unavailable');
 if(candidate.precision==='house'&&(p.categories!=='adr_address'||p.street_id!==candidate.streetId||typeof p.name!=='string'||normalHouse(p.name)!==normalHouse(input.house)))throw mapError('map_unavailable');
 if(candidate.precision==='street'&&p.categories!=='adr_street')throw mapError('map_unavailable');
 const xy=data.geo_centroid?.coordinates;
 if(!Array.isArray(xy)||xy.length!==2||!xy.every(Number.isFinite)||Math.abs(xy[0])>180||Math.abs(xy[1])>90)throw mapError('map_unavailable');
 return {...candidate,source:'visicom',city:city.name,checkedAt:now,longitude:xy[0],latitude:xy[1],url:`https://maps.visicom.ua/c/${xy[0]},${xy[1]},17/f/${candidate.featureId}?lang=uk`,
  label:`${city.name}, ${candidate.streetType} ${candidate.street}${candidate.matchedHouse?', '+candidate.matchedHouse:''}`};
}
