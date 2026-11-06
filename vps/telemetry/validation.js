import {readFileSync} from 'node:fs';
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
export const diagnosticSchema=JSON.parse(readFileSync(new URL('./report.schema.json',import.meta.url),'utf8'));
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
export const problem=(status,code,reason='schema')=>Object.assign(Error('Некоректний або недозволений запит'),{status,code,reason});
function dateTime(value){
 const m=/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(value);
 if(!m||!Number.isFinite(Date.parse(value)))return false;
 const y=+m[1],month=+m[2],day=+m[3],leap=y%4===0&&(y%100!==0||y%400===0);
 return month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}
function conforms(value,s){
 if(s.const!==undefined&&value!==s.const)return false;
 if(s.enum&&!s.enum.includes(value))return false;
 if(s.type==='object')return object(value)&&(!s.required||s.required.every(k=>Object.hasOwn(value,k)))&&Object.keys(value).every(k=>Object.hasOwn(s.properties||{},k)?conforms(value[k],s.properties[k]):s.additionalProperties!==false);
 if(s.type==='array')return Array.isArray(value)&&value.length>=(s.minItems||0)&&value.length<=(s.maxItems??Infinity)&&value.every(v=>conforms(v,s.items));
 if(s.type==='string')return typeof value==='string'&&value.length>=(s.minLength||0)&&value.length<=(s.maxLength??Infinity)&&(!s.pattern||new RegExp(s.pattern).test(value))&&(!s.format||s.format==='uuid'&&uuid.test(value)||s.format==='date-time'&&dateTime(value));
 if(s.type==='integer')return Number.isInteger(value)&&value>=(s.minimum??-Infinity)&&value<=(s.maximum??Infinity);
 return true;
}
export class RequestIds {
 constructor(secret,{now=Date.now}={}){Object.assign(this,{secret,now});}
 mac(core,scope){return createHmac('sha256',this.secret).update('diagnostic-request-v1:'+scope+':'+core).digest('base64url').slice(0,22);}
 issue(owner=null){const id=randomUUID(),core=id.replaceAll('-','')+'_'+Math.floor(this.now()/1000).toString(36);return {id,token:core+'_'+this.mac(core,owner||'public')};}
 verify(token,owner=null){
  if(typeof token!=='string')return null;const m=/^([a-f0-9]{32})_([a-z0-9]{6,9})_([A-Za-z0-9_-]{22})$/.exec(token);if(!m)return null;
  const age=this.now()/1000-parseInt(m[2],36);if(age< -60||age>86400)return null;
  const core=m[1]+'_'+m[2];if(![owner||'public','public'].some(scope=>timingSafeEqual(Buffer.from(m[3]),Buffer.from(this.mac(core,scope)))))return null;
  return m[1].replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
 }
}
export function diagnosticPacket(input,{requestIds,owner,consent}={}){
 if(!conforms(input,diagnosticSchema))throw problem(400,'invalid_report');
 if(typeof consent!=='string'||consent.toLowerCase()!==input.reportId.toLowerCase())throw problem(403,'diagnostic_consent_required','owner');
 const p=JSON.parse(JSON.stringify(input));p.reportId=p.reportId.toLowerCase();
 if(p.correlationId!==undefined){const id=requestIds?.verify(p.correlationId,owner);if(!id)throw problem(400,'untrusted_correlation');p.correlationId=id;}
 return p;
}
function keys(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw problem(400,'unknown_fields');}
const publicKeys={search:['schemaVersion','kind','parentId','q','cursor','limit'],resolve:['schemaVersion','addressId','lineId','unit'],'legacy-resolve':['schemaVersion','legacy'],snapshots:['schemaVersion','fromDate','toDate','items']};
const profileKeys={bootstrap:[],sync:['id','reason','subscription'],resolve_queue:['id','address'],dictionary:['kind','parent'],preview:['address'],save:['confirmed','address','name'],refresh:['id'],weather:['id'],delete:['id'],rename:['id','name'],preferences:['id','preferences'],subscribe:['id','subscription'],unsubscribe:['endpoint'],erase:[]};
export const knownRoutes=new Set(['/api','/api/session','/api/v1/catalog','/api/v1/capabilities','/api/v1/search','/api/v1/resolve','/api/v1/legacy-resolve','/api/v1/snapshots','/api/v1/map-search','/api/v1/sensors','/api/v1/sensor-events','/api/v1/sensor-devices/register','/api/v1/sensor-devices/control','/api/v1/diagnostic-reports','/diagnostic-reports']);
knownRoutes.add('/api/v1/settlements');knownRoutes.add('/api/v1/settlement-routes');
knownRoutes.add('/api/v1/settlement-catalog');knownRoutes.add('/api/v1/settlement-search');
export const routeTag=path=>knownRoutes.has(path)?path:'unknown_api';
export function validateRequest(route,p){
 const op=route.split('/').at(-1);
 if(publicKeys[op]){
  keys(p,publicKeys[op]);
  if(op==='search'&&!['cities','streets','houses'].includes(p.kind))throw problem(400,'invalid_search');
  if(op==='legacy-resolve')keys(p.legacy,['department','cityId','streetId','house']);
  if(op==='snapshots'&&Array.isArray(p.items))for(const item of p.items)keys(item,['addressId','revision']);
 }else if(route==='/api'){
  if(typeof p.action!=='string'||!Object.hasOwn(profileKeys,p.action))throw problem(400,'unknown_operation','operation');keys(p,['action',...profileKeys[p.action]]);
  if(p.id!==undefined&&p.id!==null&&(typeof p.id!=='string'||!uuid.test(p.id)))throw problem(400,'invalid_profile_id');
  if(p.name!==undefined&&(typeof p.name!=='string'||p.name.length>60))throw problem(400,'invalid_name');
  if(p.reason!==undefined&&(typeof p.reason!=='string'||p.reason.length>40))throw problem(400,'invalid_reason');
  if(p.confirmed!==undefined&&typeof p.confirmed!=='boolean')throw problem(400,'invalid_confirmation');
  if(p.endpoint!==undefined&&(typeof p.endpoint!=='string'||p.endpoint.length>2048))throw problem(400,'invalid_endpoint');
  if(p.action==='dictionary'&&(!['department','city','street','house'].includes(p.kind)||p.parent!==undefined&&typeof p.parent!=='string'))throw problem(400,'invalid_dictionary');
  if(p.address!==undefined){keys(p.address,['department','cityId','streetId','house','city','street','label','canonicalAddressId','operatorId','lineId','lineLabel','multipleLines','synthetic','queueUnresolved','mapCandidateToken']);if(Object.entries(p.address).some(([k,v])=>['multipleLines','synthetic','queueUnresolved'].includes(k)?typeof v!=='boolean':v!==null&&typeof v!=='string'))throw problem(400,'invalid_address');if(p.address.mapCandidateToken!==undefined&&(Object.keys(p.address).length!==1||p.action!=='save'||typeof p.address.mapCandidateToken!=='string'||p.address.mapCandidateToken.length>5000))throw problem(400,'invalid_address');}
  if(p.preferences!==undefined){keys(p.preferences,['schedule','publication','change','emergency','reminder','restoration','lead']);if(Object.entries(p.preferences).some(([k,v])=>k==='lead'?!Number.isInteger(v)||v<0||v>120:typeof v!=='boolean'))throw problem(400,'invalid_preferences');}
  if(p.subscription!==undefined&&p.subscription!==null){keys(p.subscription,['endpoint','expirationTime','keys']);keys(p.subscription.keys,['auth','p256dh']);
   if(typeof p.subscription.endpoint!=='string'||p.subscription.endpoint.length>2048||['auth','p256dh'].some(k=>typeof p.subscription.keys[k]!=='string'||p.subscription.keys[k].length>128)||p.subscription.expirationTime!==undefined&&p.subscription.expirationTime!==null&&(!Number.isFinite(p.subscription.expirationTime)||p.subscription.expirationTime<0))throw problem(400,'invalid_subscription');
  }
 }else if(route==='/api/v1/map-search'){keys(p,['schemaVersion','cityId','streetId','street','house']);}
 else if(route==='/api/session')keys(p,[]);
 else if(route==='/api/v1/catalog'){keys(p,['kind','parent']);if(!['department','city','street','house'].includes(p.kind)||p.parent!==undefined&&typeof p.parent!=='string')throw problem(400,'invalid_dictionary');}
 // Bound structure and reject control characters; apostrophes/SQL words/Unicode remain data.
 const pending=[[p,0]];let count=0;while(pending.length){const [v,d]=pending.pop();if(++count>256||d>6)throw problem(400,'invalid_structure');
  if(typeof v==='string'&&/[\u0000-\u001f\u007f]/.test(v))throw problem(400,'invalid_control','control');
  if(v&&typeof v==='object')for(const value of Object.values(v))pending.push([value,d+1]);
 }
}
