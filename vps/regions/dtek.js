import {randomBytes} from 'node:crypto';
export const REGIONS=Object.freeze({
 'ua-kyiv-dtek':{host:'www.dtek-kem.com.ua',label:'ДТЕК Київські електромережі',region:'м. Київ',city:'м. Київ'},
 'ua-kyiv-region-dtek':{host:'www.dtek-krem.com.ua',label:'ДТЕК Київські регіональні електромережі',region:'Київська область'}
});
export const regionError=(code,status=503)=>Object.assign(Error(code),{code,status});
export function csrfCookieToken(value){const match=decodeURIComponent(value||'').match(/i:1;s:\d+:"([^"\x00-\x1f]{16,128})"/);return match?.[1]||null;}
export function maskedCsrf(token){const raw=Buffer.from(token),mask=randomBytes(raw.length);return Buffer.concat([mask,Buffer.from(raw.map((v,i)=>v^mask[i]))]).toString('base64url');}
export async function boundedBody(response,max=2500000){
 if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw regionError('source_payload_too_large');}
 const chunks=[];let size=0;for await(const chunk of response.body||[]){size+=chunk.byteLength;if(size>max)throw regionError('source_payload_too_large');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');
}
// Two fixed public read actions. This client never submits outage reports, meter readings or account data.
export class DtekClient {
 constructor(operator,{fetcher=fetch,gate=async()=>{},finish=async()=>{},now=Date.now}={}){
  if(!REGIONS[operator])throw regionError('unsupported_operator',400);Object.assign(this,{operator,fetcher,gate,finish,now});this.config=REGIONS[operator];this.cookies=new Map();this.csrf=null;this.sessionUntil=0;this.boot=null;
 }
 async post(form,token){
  const ticket=await this.gate(this.operator);let status=0,error=null,retry=0;
  try{const response=await this.fetcher(`https://${this.config.host}/ua/ajax`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),
   headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8',accept:'application/json','user-agent':'Svitlo-private-staging/1.0',origin:`https://${this.config.host}`,referer:`https://${this.config.host}/ua/shutdowns`,'x-requested-with':'XMLHttpRequest',...(this.cookies.size?{cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; ')}:{}),...(token?{'x-csrf-token':maskedCsrf(token)}:{})},body:new URLSearchParams(form).toString()});
   status=response.status;retry=Math.max(0,Math.min(900000,Number(response.headers.get('retry-after'))*1000||0));
   for(const line of response.headers.getSetCookie?.()||[]){const pair=line.split(';',1)[0],i=pair.indexOf('=');if(i<1||pair.length>4096)continue;const name=pair.slice(0,i),value=pair.slice(i+1);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(name)||this.cookies.size>=16&&!this.cookies.has(name))continue;this.cookies.set(name,value);if(name==='_csrf-dtek-'+(this.operator==='ua-kyiv-dtek'?'kem':'krem')){this.csrf=csrfCookieToken(value);this.sessionUntil=this.now()+1800000;}}
   const text=await boundedBody(response);if(text.includes('_Incapsula_Resource')||status===403){error='forbidden';throw regionError('forbidden');}if(status===429){error='rate_limited';throw regionError('rate_limited',429);}if(status!==200&&status!==400)throw regionError('source_http_'+status);
   if(status===400)return {status,data:null};let data;try{data=JSON.parse(text);}catch{throw regionError('invalid_source_json');}return {status,data};
  }catch(e){error=error||e.code||(e.name==='TimeoutError'?'timeout':'source_unavailable');throw e;}
  finally{await this.finish(this.operator,ticket,{status,error,retry}).catch(()=>{});}
 }
 async session(){if(this.csrf&&this.sessionUntil>this.now())return;if(!this.boot)this.boot=(async()=>{this.csrf=null;await this.post({method:'getHomeNum'});if(!this.csrf)throw regionError('source_session_unavailable');})().finally(()=>{this.boot=null;});await this.boot;}
 async read(form){await this.session();let result=await this.post(form,this.csrf);if(result.status===400){this.csrf=null;await this.session();result=await this.post(form,this.csrf);}if(result.status!==200||result.data?.result!==true)throw regionError('source_address_unavailable');return result.data;}
 async streets(){const data=(await this.read({method:'getStreets'})).streets;
  if(this.config.city){if(!Array.isArray(data)||!data.length||data.length>10000||data.some(s=>typeof s!=='string'||!s||s.length>240))throw regionError('invalid_street_index');return {[this.config.city]:data};}
  if(!data||Array.isArray(data)||typeof data!=='object'||!Object.keys(data).length||Object.keys(data).length>5000||Object.entries(data).some(([city,streets])=>!city||city.length>160||!Array.isArray(streets)||streets.length>10000||streets.some(s=>typeof s!=='string'||!s||s.length>240)))throw regionError('invalid_street_index');return data;
 }
 async houses(city,street){if(typeof city!=='string'||!city||city.length>160||typeof street!=='string'||!street||street.length>240||/[\x00-\x1f]/.test(city+street))throw regionError('invalid_source_address',400);
  return this.read({method:'getHomeNum','data[0][name]':'city','data[0][value]':this.config.city||city,'data[1][name]':'street','data[1][value]':street,'data[2][name]':'updateFact','data[2][value]':'1'});
 }
}
