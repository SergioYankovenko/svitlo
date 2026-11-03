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
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.ico':'image/x-icon'};
const quotas=new Map();
function budget(key,limit){const now=Date.now(),v=quotas.get(key);if(quotas.size>10000)for(const [k,x] of quotas)if(x.until<now)quotas.delete(k);
  if(v?.until>now)return ++v.count<=limit;quotas.set(key,{count:1,until:now+3600000});return true;}
function json(res,status,data,reason){if(res.telemetryMeta)telemetry.reject({...res.telemetryMeta,status,reason});if(status===429&&!res.hasHeader('Retry-After'))res.setHeader('Retry-After','60');res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
async function body(req,limit=16384){let size=0,parts=[];for await(const c of req){size+=c.length;if(size<=limit)parts.push(c);}if(size>limit)throw problem(413,'payload_too_large','size');try{const value=JSON.parse(Buffer.concat(parts).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw problem(400,'invalid_json');}}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  const start=Date.now();let path;
  try{
    if(req.headers.host!==new URL(origin).host)return json(res,421,{error:'Host is not allowed'});
    const url=new URL(req.url,origin);path=url.pathname;
    if(path==='/healthz')return json(res,200,{status:'ok',scope:'isolated-staging',release});
    if(path==='/readyz'){
      const r=await rt.p.query("select schema_version,delivery_mode,exists(select 1 from svitlo_vps.migrations where name='1006_sensor_ingest.sql') and exists(select 1 from pg_proc where pronamespace='svitlo_sensors'::regnamespace and proname='phone_ingest') as universal_ready from svitlo_vps.release_state where id");
      if(r.rows[0]?.schema_version!==1||r.rows[0]?.delivery_mode!=='disabled'||!r.rows[0].universal_ready)throw Error('Schema or delivery mode mismatch');
      return json(res,200,{status:'ready',scope:'isolated-staging',release,schema:1,delivery:'disabled',productionReady:false});
    }
    if(path==='/api/v1/sensor-events'||path==='/api/v1/sensor-devices/register'||path==='/api/v1/sensor-devices/control'){
      const trace=telemetry.requestIds.issue();res.telemetryMeta={path:routeTag(path),correlationId:trace.id};res.setHeader('X-Svitlo-Request-ID',trace.token);
      if(url.search)throw problem(400,'sensor_query_not_allowed');
      if(!budget('device-http:'+req.socket.remoteAddress,4000))throw problem(429,'device_http_limit','rate');
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(req.headers.origin!==undefined||req.headers.cookie!==undefined)throw problem(403,'device_transport_required','owner');
      if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')return json(res,415,{error:'JSON required'});
      if(path.endsWith('/register')){if(!budget('device-register:'+req.socket.remoteAddress,30))throw problem(429,'phone_registration_limit','rate');return json(res,200,await phone.register(await body(req,1024)));}
      if(path.endsWith('/control'))return json(res,200,await phone.control(req.headers.authorization,await body(req,1024)));
      const packet=await body(req,16384);if(packet.schemaVersion===3){const release=sensorIngest.admission.acquire();try{return json(res,200,await phone.batch(req.headers.authorization,packet));}finally{release();}}return json(res,200,await sensorIngest.handle(req.headers.authorization,packet));
    }
    if(path.startsWith('/api')||path==='/diagnostic-reports'){
      const trace=telemetry.requestIds.issue();res.telemetryMeta={path:routeTag(path),correlationId:trace.id};res.setHeader('X-Svitlo-Request-ID',trace.token);
      if(!budget('http:'+req.socket.remoteAddress,4000)){res.setHeader('Retry-After','3600');return json(res,429,{error:'Забагато запитів'});}
      const publicReader=path.startsWith('/api/v1/')&&['/api/v1/capabilities','/api/v1/search','/api/v1/resolve','/api/v1/legacy-resolve','/api/v1/snapshots'].includes(path);
      if(req.method!=='GET'&&req.headers.origin!==origin&&(!publicReader||req.headers.origin))return json(res,403,{error:'Origin rejected'});
      if(req.method!=='GET'&&req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')return json(res,415,{error:'JSON required'});
      let s=await sessions.read(req);if(s?.renewed)res.setHeader('Set-Cookie',sessions.cookie(s.token));
      if(s){const ownedTrace=telemetry.requestIds.issue(s.owner);res.telemetryMeta.correlationId=ownedTrace.id;res.setHeader('X-Svitlo-Request-ID',ownedTrace.token);}
      if(path==='/api/session'){
        if(req.method==='GET')return json(res,200,{session:s?sessions.public(s):null});
        if(req.method==='POST'){
          validateRequest(path,await body(req));
          if(!s){if(!budget('sessions:'+req.socket.remoteAddress,30))return json(res,429,{error:'Забагато нових сесій'});s=await sessions.create();res.setHeader('Set-Cookie',sessions.cookie(s.token));}
          return json(res,200,{session:sessions.public(s)});
        }
        if(req.method==='DELETE'){
          if(s&&!sessions.validCsrf(req,s))return json(res,403,{error:'CSRF rejected'});
          if(s)await sessions.revoke(s);res.setHeader('Set-Cookie',sessions.cookie('',0));return json(res,200,{ok:true});
        }
        return json(res,405,{error:'Method not allowed'});
      }
      if(path==='/api/v1/capabilities'&&req.method==='GET')return json(res,200,{...await rt.reader.capabilities(),sensorAccess:sensorCapabilities,sensorIngest:ingestCapabilities,phoneSensors:phoneCapabilities,diagnostics:{schemaVersion:1,maxBytes:8192,maxEvents:8,explicitConsent:true,requiresSession:true}});
      if(publicReader&&req.method==='POST'){
        if(path.endsWith('/capabilities'))return json(res,405,{error:'Method not allowed'});
        const data=await body(req);validateRequest(path,data);rt.reader.checkVersion(data);
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
      const report=path==='/diagnostic-reports'||path==='/api/v1/diagnostic-reports';
      if(report){
        if(url.search)throw problem(400,'query_not_allowed');
        if(!budget('reports:'+req.socket.remoteAddress,300)){res.setHeader('Retry-After','3600');throw problem(429,'diagnostic_abuse_limit','rate');}
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
      if(data.action==='subscribe')return json(res,409,{error:'Доставка сповіщень вимкнена в тестовій версії'});
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
  }catch(e){const status=e.status||(e.code==='ENOENT'?404:503);if(e.retryAfter)res.setHeader('Retry-After',String(e.retryAfter));json(res,status,{error:status===503?'Сервіс тимчасово недоступний':e.message,code:status===503?'temporarily_unavailable':e.code||'request_rejected'},e instanceof SourceError?'upstream':e.reason);
    if(status>=500)console.error(JSON.stringify({event:'request_failed',route:routeTag(path),code:'service_error'}));
  }finally{if(res.telemetryMeta)console.log(JSON.stringify({event:'request',route:routeTag(path),status:res.statusCode,ms:Date.now()-start}));}
});
server.requestTimeout=125000;server.headersTimeout=15000;server.maxConnections=100;
server.listen(8080,'0.0.0.0',()=>console.log(JSON.stringify({event:'listening',release,delivery:'disabled'})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(async()=>{await Promise.race([telemetry.sink.flush(),new Promise(r=>setTimeout(r,2000))]);await Promise.all([rt.p.end(),sessionPool.end()]);process.exit(0);});setTimeout(()=>process.exit(1),130000).unref();});
