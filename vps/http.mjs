import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {runtime} from './runtime.js';
import {pool,ownerContext} from './db.js';
import {Sessions} from './session.js';
import {Telemetry} from './telemetry/service.js';
import {problem,validateRequest,routeTag} from './telemetry/validation.js';
import {SourceError} from '../server/source-errors.js';
import {SensorAccess,sensorCapabilities} from './sensors/service.js';
import {SensorIngest,ingestCapabilities} from './sensors/ingest.js';
import {PhoneSensors,phoneCapabilities} from './sensors/phone.js';
import {HttpAdmission,clientKey} from './admission.js';
const rt=await runtime(),sessionPool=pool('session',2),sessions=new Sessions(sessionPool,rt.secret);
const telemetry=new Telemetry(rt.bridge,rt.secret);
const sensorSecret=(await readFile('/run/secrets/sensor_access_secret','utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(sensorSecret))throw Error('Sensor access secret unavailable');
const phoneSecret=(await readFile('/run/secrets/phone_secret','utf8')).trim();
const phone=new PhoneSensors({bridge:rt.bridge,secret:phoneSecret});
const sensors=new SensorAccess({bridge:rt.bridge,db:rt.db,secret:sensorSecret,phone});
const sensorIngest=new SensorIngest(rt.bridge);
const root=resolve('dist/app'),origin=process.env.STAGE_ORIGIN||'http://localhost:18765';
const release=process.env.RELEASE_ID||'development';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
// Session metadata has a separate bounded pool; mutations/devices keep 32/s.
const admission=new HttpAdmission();
const budget=(key,limit)=>admission.budget(key,limit);
function json(res,status,data,reason){if(res.telemetryMeta)telemetry.reject({...res.telemetryMeta,status,reason});if(status===429&&!res.hasHeader('Retry-After'))res.setHeader('Retry-After','60');res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
async function body(req,limit=16384,legacyLimit=0){let size=0,parts=[];for await(const c of req){size+=c.length;if(size<=limit)parts.push(c);}if(size>limit)throw problem(413,'payload_too_large','size');let value;try{value=JSON.parse(Buffer.concat(parts).toString());}catch{if(legacyLimit&&size>legacyLimit)throw problem(413,'payload_too_large','size');throw problem(400,'invalid_json');}if(legacyLimit&&value?.schemaVersion!==3&&size>legacyLimit)throw problem(413,'payload_too_large','size');if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,'invalid_json');return value;}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const start=Date.now();let path,leave=()=>{};
  try{
    if(req.headers.host!==new URL(origin).host)return json(res,421,{error:'Host is not allowed'});
    const url=new URL(req.url,origin);path=url.pathname;
    if(path==='/healthz')return json(res,200,{status:'ok',scope:'isolated-staging',release});
    if(path==='/readyz'){
      const r=await rt.p.query("select schema_version,delivery_mode,exists(select 1 from svitlo_vps.migrations where name='1011_operations.sql') and exists(select 1 from svitlo_vps.migrations where name='1010_kyiv_regions.sql') and exists(select 1 from svitlo_vps.migrations where name='1008_map_addresses.sql') and exists(select 1 from svitlo_vps.migrations where name='1007_sensor_history.sql') and exists(select 1 from pg_proc where pronamespace='svitlo_sensors'::regnamespace and proname='phone_ingest') as universal_ready from svitlo_vps.release_state where id");
      if(r.rows[0]?.schema_version!==1||r.rows[0]?.delivery_mode!=='disabled'||!r.rows[0].universal_ready)throw Error('Schema or delivery mode mismatch');
      if(!(await rt.p.query("select exists(select 1 from svitlo_vps.migrations where name='1014_main_app_subscription.sql') and to_regprocedure('svitlo_sensors.main_app_entitlement()') is not null ok")).rows[0]?.ok)throw Error('Main app subscription readiness mismatch');
      if(!await rt.geography.ready())throw Error('Settlement directory readiness mismatch');
      if(!(await rt.p.query("select exists(select 1 from svitlo_vps.migrations where name='1019_geography_discovery.sql') and to_regprocedure('svitlo_discovery.catalog_entry(text,text,text,uuid,text,text)') is not null ok")).rows[0]?.ok)throw Error('Settlement discovery readiness mismatch');
      if(rt.delivery==='pilot-enabled'&&!(await rt.p.query("select pilot_push_enabled and exists(select 1 from svitlo_vps.migrations where name='1013_pilot_push.sql') ok from svitlo_vps.release_state where id")).rows[0]?.ok)throw Error('Pilot push readiness mismatch');
      return json(res,200,{status:'ready',scope:'isolated-staging',release,schema:1,delivery:rt.delivery,productionReady:false});
    }
    const client=clientKey(req,rt.secret);
    if(path.startsWith('/api')||path==='/diagnostic-reports')leave=admission.acquire(path,req.method);
    if(path==='/api/v1/sensor-events'||path==='/api/v1/sensor-devices/register'||path==='/api/v1/sensor-devices/control'){
      const trace=telemetry.requestIds.issue();res.telemetryMeta={path:routeTag(path),correlationId:trace.id};res.setHeader('X-Svitlo-Request-ID',trace.token);
      if(url.search)throw problem(400,'sensor_query_not_allowed');
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(req.headers.origin!==undefined||req.headers.cookie!==undefined)throw problem(403,'device_transport_required','owner');
      if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')return json(res,415,{error:'JSON required'});
      if(path.endsWith('/register')){if(!budget('device-register:'+client,30))throw problem(429,'phone_registration_limit','rate');return json(res,200,await phone.register(await body(req,1024)));}
      if(path.endsWith('/control'))return json(res,200,await phone.control(req.headers.authorization,await body(req,1024)));
      const packet=await body(req,16384,2048);if(packet.schemaVersion===3){const release=sensorIngest.admission.acquire();try{return json(res,200,await phone.batch(req.headers.authorization,packet));}finally{release();}}return json(res,200,await sensorIngest.handle(req.headers.authorization,packet));
    }
    if(path.startsWith('/api')||path==='/diagnostic-reports'){
      const trace=telemetry.requestIds.issue();res.telemetryMeta={path:routeTag(path),correlationId:trace.id};res.setHeader('X-Svitlo-Request-ID',trace.token);
      const publicReader=path.startsWith('/api/v1/')&&['/api/v1/capabilities','/api/v1/search','/api/v1/resolve','/api/v1/legacy-resolve','/api/v1/snapshots','/api/v1/settlements','/api/v1/settlement-routes','/api/v1/settlement-catalog','/api/v1/settlement-search'].includes(path);
      if(['/api/v1/settlements','/api/v1/settlement-routes','/api/v1/settlement-catalog','/api/v1/settlement-search'].includes(path)&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(req.method!=='GET'&&req.headers.origin!==origin&&(!publicReader||req.headers.origin))return json(res,403,{error:'Origin rejected'});
      if(req.method!=='GET'&&req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')return json(res,415,{error:'JSON required'});
      let s=await sessions.read(req);if(s?.renewed)res.setHeader('Set-Cookie',sessions.cookie(s.token));
      if(s){const ownedTrace=telemetry.requestIds.issue(s.owner);res.telemetryMeta.correlationId=ownedTrace.id;res.setHeader('X-Svitlo-Request-ID',ownedTrace.token);}
      if(path==='/api/session'){
        if(req.method==='GET')return json(res,200,{session:s?sessions.public(s):null});
        if(req.method==='POST'){
          validateRequest(path,await body(req));
          if(!s){if(!budget('sessions:'+client,30))return json(res,429,{error:'Забагато нових сесій'});s=await sessions.create();res.setHeader('Set-Cookie',sessions.cookie(s.token));}
          return json(res,200,{session:sessions.public(s)});
        }
        if(req.method==='DELETE'){
          if(s&&!sessions.validCsrf(req,s))return json(res,403,{error:'CSRF rejected'});
          if(s)await sessions.revoke(s);res.setHeader('Set-Cookie',sessions.cookie('',0));return json(res,200,{ok:true});
        }
        return json(res,405,{error:'Method not allowed'});
      }
      if(path==='/api/v1/capabilities'&&req.method==='GET')return json(res,200,{...await rt.reader.capabilities(),push:rt.delivery==='pilot-enabled',sensorAccess:{...sensorCapabilities,notifications:rt.delivery==='pilot-enabled'},sensorIngest:ingestCapabilities,phoneSensors:phoneCapabilities,diagnostics:{schemaVersion:1,maxBytes:8192,maxEvents:8,explicitConsent:true,requiresSession:true}});
      if(publicReader&&req.method==='POST'){
        if(path.endsWith('/capabilities'))return json(res,405,{error:'Method not allowed'});
        const data=await body(req);validateRequest(path,data);rt.reader.checkVersion(data);
        if(path==='/api/v1/settlement-catalog'||path==='/api/v1/settlement-search'){
          if(url.search)throw problem(400,'settlement_query_not_allowed');
          if(!budget('settlement-catalog:'+client,600))throw problem(429,'settlement_catalog_limit','rate');
          return json(res,200,path==='/api/v1/settlement-catalog'?await rt.discoveryCatalog.city(data):await rt.discoveryCatalog.search(data));
        }
        if(path==='/api/v1/settlements'||path==='/api/v1/settlement-routes'){
          if(url.search)throw problem(400,'settlement_query_not_allowed');
          return json(res,200,path==='/api/v1/settlements'?await rt.geography.search(data):await rt.geography.routes(data));
        }
        const result=path.endsWith('/search')?await rt.reader.catalog.search(data):path.endsWith('/resolve')?await rt.reader.resolve(data):path.endsWith('/legacy-resolve')?await rt.reader.catalog.legacy(data.legacy):path.endsWith('/snapshots')?await rt.reader.batch(data):null;
        return json(res,200,result);
      }
      if(!s)return json(res,401,{error:'Потрібна сесія'});
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(!sessions.validCsrf(req,s))return json(res,403,{error:'CSRF rejected'});
      if(path==='/api/v1/sensors'){
        if(url.search)throw problem(400,'sensor_query_not_allowed');
        const data=await body(req,4096);return json(res,200,await ownerContext.run(s.owner,()=>sensors.handle(s.owner,data)));
      }
      if(path==='/api/v1/map-search'){
        if(url.search)throw problem(400,'query_not_allowed');
        const data=await body(req,2048);validateRequest(path,data);rt.reader.checkVersion(data);
        return json(res,200,await ownerContext.run(s.owner,()=>rt.maps.search(s.owner,data)));
      }
      const report=path==='/diagnostic-reports'||path==='/api/v1/diagnostic-reports';
      if(report){
        if(url.search)throw problem(400,'query_not_allowed');
        if(!budget('reports:'+s.owner,30)){res.setHeader('Retry-After','3600');throw problem(429,'diagnostic_abuse_limit','rate');}
        const data=await body(req,8192),accepted=await ownerContext.run(s.owner,()=>telemetry.submit(s.owner,data,req.headers['x-svitlo-diagnostic-consent']));
        return json(res,accepted.status,accepted.receipt);
      }
      const data=await body(req);validateRequest(path,data);
      if(path==='/api/v1/catalog')return await ownerContext.run(s.owner,async()=>{
        if(!await rt.db.rate(s.owner,120,60000))return json(res,429,{error:'Забагато запитів'});
        const kind=data.kind,parent=String(data.parent||'');
        if(!['department','city','street','house'].includes(kind)||parent.length>120)return json(res,400,{error:'Invalid dictionary request'});
        const items=await rt.db.addressDictionary(kind,parent);
        return json(res,200,{items,operator:'ua-cherkasy',scope:'christynivka-branch-18'});
      });
      if(path!=='/api')return json(res,404,{error:'Unknown API route'});
      if(data.action==='subscribe'&&rt.delivery!=='pilot-enabled')return json(res,409,{error:'Доставка сповіщень вимкнена в тестовій версії'});
      const result=await ownerContext.run(s.owner,async()=>{const value=await rt.service.handle(s.owner,data);if(data.action==='erase')await telemetry.forget();return value;});
      return json(res,200,result);
    }
    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Method not allowed'});
    if(path==='/'){res.writeHead(302,{location:'/app/'});return res.end();}
    if(path==='/app'){res.writeHead(302,{location:'/app/'});return res.end();}
    if(!path.startsWith('/app/'))return json(res,404,{error:'Not found'});
    const file=resolve(root,decodeURIComponent(path.slice(5))||'index.html');
    if(!file.startsWith(root+'/')&&file!==root) return json(res,404,{error:'Not found'});
    const info=await stat(file);if(!info.isFile())return json(res,404,{error:'Not found'});
    res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'no-cache','content-length':info.size});
    res.end(req.method==='HEAD'?undefined:await readFile(file));
  }catch(e){const status=e.status||(e.code==='ENOENT'?404:503);if(e.retryAfter)res.setHeader('Retry-After',String(e.retryAfter));const unavailableCode=path==='/api/v1/sensors'&&e.code==='subscription_check_unavailable'?'subscription_check_unavailable':'temporarily_unavailable';json(res,status,{error:status===503?'Сервіс тимчасово недоступний':e.message,code:status===503?unavailableCode:e.code||'request_rejected'},e instanceof SourceError?'upstream':e.reason);
    if(status>=500)console.error(JSON.stringify({event:'request_failed',route:routeTag(path),code:'service_error'}));
  }finally{leave();if(res.telemetryMeta)console.log(JSON.stringify({event:'request',route:routeTag(path),status:res.statusCode,ms:Date.now()-start}));}
});
server.requestTimeout=125000;server.headersTimeout=15000;server.maxConnections=100;
server.listen(8080,'0.0.0.0',()=>console.log(JSON.stringify({event:'listening',release,delivery:rt.delivery})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(async()=>{await Promise.race([telemetry.sink.flush(),new Promise(r=>setTimeout(r,2000))]);await Promise.all([rt.p.end(),sessionPool.end()]);process.exit(0);});setTimeout(()=>process.exit(1),130000).unref();});
