import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {runtime} from './runtime.js';
import {pool,ownerContext} from './db.js';
import {Sessions} from './session.js';
const rt=await runtime(),sessionPool=pool('session',2),sessions=new Sessions(sessionPool,rt.secret);
const root=resolve('dist/app'),origin=process.env.STAGE_ORIGIN||'http://localhost:18765';
const release=process.env.RELEASE_ID||'development';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.ico':'image/x-icon'};
const quotas=new Map();
function budget(key,limit){const now=Date.now(),v=quotas.get(key);if(quotas.size>10000)for(const [k,x] of quotas)if(x.until<now)quotas.delete(k);
  if(v?.until>now)return ++v.count<=limit;quotas.set(key,{count:1,until:now+3600000});return true;}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let size=0,parts=[];for await(const c of req){size+=c.length;if(size>16384)throw Object.assign(Error('Завеликий запит'),{status:413});parts.push(c);}try{const value=JSON.parse(Buffer.concat(parts).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw Object.assign(Error('Некоректний JSON'),{status:400});}}
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
      const r=await rt.p.query("select schema_version,delivery_mode,exists(select 1 from svitlo_vps.migrations where name='1003_catalog_quality.sql') as universal_ready from svitlo_vps.release_state where id");
      if(r.rows[0]?.schema_version!==1||r.rows[0]?.delivery_mode!=='disabled'||!r.rows[0].universal_ready)throw Error('Schema or delivery mode mismatch');
      return json(res,200,{status:'ready',scope:'isolated-staging',release,schema:1,delivery:'disabled',productionReady:false});
    }
    if(path.startsWith('/api')){
      if(!budget('http:'+req.socket.remoteAddress,4000))return json(res,429,{error:'Забагато запитів'});
      const publicReader=path.startsWith('/api/v1/')&&['/api/v1/capabilities','/api/v1/search','/api/v1/resolve','/api/v1/legacy-resolve','/api/v1/snapshots'].includes(path);
      if(req.method!=='GET'&&((req.headers.origin!==origin&&(!publicReader||req.headers.origin))||req.headers['content-type']?.split(';')[0]!=='application/json'))return json(res,403,{error:'Origin or content type rejected'});
      let s=await sessions.read(req);
      if(path==='/api/session'){
        if(req.method==='GET')return json(res,200,{session:s?sessions.public(s):null});
        if(req.method==='POST'){
          await body(req);
          if(!s){if(!budget('sessions:'+req.socket.remoteAddress,30))return json(res,429,{error:'Забагато нових сесій'});s=await sessions.create();res.setHeader('Set-Cookie',sessions.cookie(s.token));}
          return json(res,200,{session:sessions.public(s)});
        }
        if(req.method==='DELETE'){
          if(s&&!sessions.validCsrf(req,s))return json(res,403,{error:'CSRF rejected'});
          if(s)await sessions.revoke(s);res.setHeader('Set-Cookie',sessions.cookie('',0));return json(res,200,{ok:true});
        }
        return json(res,405,{error:'Method not allowed'});
      }
      if(path==='/api/v1/capabilities'&&req.method==='GET')return json(res,200,await rt.reader.capabilities());
      if(publicReader&&req.method==='POST'){
        if(path.endsWith('/capabilities'))return json(res,405,{error:'Method not allowed'});
        const data=await body(req);rt.reader.checkVersion(data);
        const result=path.endsWith('/search')?await rt.reader.catalog.search(data):path.endsWith('/resolve')?await rt.reader.resolve(data):path.endsWith('/legacy-resolve')?await rt.reader.catalog.legacy(data.legacy):path.endsWith('/snapshots')?await rt.reader.batch(data):null;
        return json(res,200,result);
      }
      if(!s)return json(res,401,{error:'Потрібна сесія'});
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(!sessions.validCsrf(req,s))return json(res,403,{error:'CSRF rejected'});
      const data=await body(req);
      if(path==='/api/v1/catalog')return await ownerContext.run(s.owner,async()=>{
        if(!await rt.db.rate(s.owner,120,60000))return json(res,429,{error:'Забагато запитів'});
        const kind=data.kind,parent=String(data.parent||'');
        if(!['department','city','street','house'].includes(kind)||parent.length>120)return json(res,400,{error:'Invalid dictionary request'});
        const items=await rt.db.addressDictionary(kind,parent);
        return json(res,200,{items,operator:'ua-cherkasy',scope:'christynivka-branch-18'});
      });
      if(path!=='/api')return json(res,404,{error:'Unknown API route'});
      if(data.action==='subscribe')return json(res,409,{error:'Доставка сповіщень вимкнена в тестовій версії'});
      const result=await ownerContext.run(s.owner,()=>rt.service.handle(s.owner,data));
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
  }catch(e){const status=e.status||(e.code==='ENOENT'?404:503);json(res,status,{error:status===503?'Сервіс тимчасово недоступний':e.message,code:status===503?'temporarily_unavailable':e.code||'request_rejected'});
    if(status>=500)console.error(JSON.stringify({event:'request_failed',route:path,code:e.code||'service_error'}));
  }finally{if(path?.startsWith('/api'))console.log(JSON.stringify({event:'request',route:path,status:res.statusCode,ms:Date.now()-start}));}
});
server.requestTimeout=125000;server.headersTimeout=15000;server.maxConnections=100;
server.listen(8080,'0.0.0.0',()=>console.log(JSON.stringify({event:'listening',release,delivery:'disabled'})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(async()=>{await Promise.all([rt.p.end(),sessionPool.end()]);process.exit(0);});setTimeout(()=>process.exit(1),130000).unref();});
