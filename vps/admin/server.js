import http from 'node:http';import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';import {readFile} from 'node:fs/promises';import {resolve,extname} from 'node:path';
const digest=s=>createHash('sha256').update(s).digest('hex');
export function createAdminServer({pool,secret,origin,root=resolve('dist/admin')}){
 const configured=new URL(origin),secure=configured.protocol==='https:';
 if(!secure&&!(configured.protocol==='http:'&&['localhost','127.0.0.1'].includes(configured.hostname)))throw Error('Secure administrative origin required');
 if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))throw Error('Independent admin secret required');
 const cookieName=secure?'__Host-svitlo_admin':'svitlo_admin',csrf=token=>createHmac('sha256',secret).update('admin-csrf:'+token).digest('hex');
 const cookie=(token,age=1800)=>`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
 const counts=new Map();let inFlight=0;
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const body=async req=>{let length=0,parts=[];for await(const c of req){length+=c.length;if(length>4096)throw Object.assign(Error(),{status:413});parts.push(c);}let p;try{p=JSON.parse(Buffer.concat(parts));}catch{throw Object.assign(Error(),{status:400});}if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error(),{status:400});return p;};
 const call=async(sql,args)=>(await pool.query(sql,args)).rows[0]?.value;
 return http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  let admitted=false;
  try{
   if(req.headers.host!==configured.host)return json(res,421,{code:'admin_host_rejected'});
   const u=new URL(req.url,origin);if(u.search&&u.pathname.startsWith('/api/'))return json(res,400,{code:'admin_query_rejected'});
   if(u.pathname==='/healthz')return json(res,200,{status:'ok',module:'admin'});
   if(u.pathname==='/readyz'){await call('select svitlo_admin.principal($1) value',['0'.repeat(64)]);return json(res,200,{status:'ready',module:'admin'});}
   if(u.pathname.startsWith('/api/')){
    if(inFlight>=4)return json(res,429,{code:'admin_busy'});inFlight++;admitted=true;
    if(!['GET','POST'].includes(req.method))return json(res,405,{code:'method_not_allowed'});
    if(req.method==='POST'&&(req.headers.origin!==origin||req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'))return json(res,403,{code:'admin_origin_rejected'});
    const peer=req.socket.remoteAddress||'unknown',now=Math.floor(Date.now()/60000);let bucket=counts.get(peer);if(!bucket||bucket.window!==now)counts.set(peer,bucket={window:now,requests:0});
    if(counts.size>1000)for(const [key,value]of counts)if(value.window!==now)counts.delete(key);
    if(++bucket.requests>120)return json(res,429,{code:'admin_rate_limited'});
    if(u.pathname==='/api/admin/login'&&req.method==='POST'){
     const p=await body(req);if(Object.keys(p).length!==1||typeof p.ticket!=='string'||!/^sa_[A-Za-z0-9_-]{43}$/.test(p.ticket))return json(res,401,{code:'admin_login_rejected'});
     const token=randomBytes(32).toString('hex'),accepted=await call('select svitlo_admin.login($1,$2) value',[digest(p.ticket),digest(token)]);
     if(!accepted)return json(res,401,{code:'admin_login_rejected'});res.setHeader('Set-Cookie',cookie(token));return json(res,200,{ok:true});
    }
    const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if(!/^[a-f0-9]{64}$/.test(token||''))return json(res,401,{code:'admin_session_required'});
    const proof=digest(token),principal=await call('select svitlo_admin.principal($1) value',[proof]);if(!principal)return json(res,401,{code:'admin_session_required'});
    if(u.pathname==='/api/admin/session'&&req.method==='GET')return json(res,200,{principal,csrf:csrf(token)});
    if(req.method!=='POST')return json(res,405,{code:'method_not_allowed'});
    const supplied=req.headers['x-svitlo-admin-csrf'];if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(csrf(token))))return json(res,403,{code:'admin_csrf_rejected'});
    const p=await body(req);
    if(u.pathname==='/api/admin/logout'){await call('select svitlo_admin.logout($1) value',[proof]);res.setHeader('Set-Cookie',cookie('',0));return json(res,200,{ok:true});}
    if(u.pathname==='/api/admin/list'){
     if(Object.keys(p).some(k=>!['resource','page','perPage'].includes(k))||typeof p.resource!=='string'||!Number.isInteger(p.page)||p.page<1||!Number.isInteger(p.perPage)||p.perPage<1||p.perPage>100)return json(res,400,{code:'invalid_admin_page'});
     return json(res,200,await call('select svitlo_admin.list($1,$2,$3,$4) value',[proof,p.resource,p.perPage,(p.page-1)*p.perPage]));
    }
    if(u.pathname==='/api/admin/command'){
     if(Object.keys(p).length!==6||p.schemaVersion!==1||typeof p.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.requestId)||typeof p.kind!=='string'||typeof p.target!=='string'||typeof p.reason!=='string'||!p.data||typeof p.data!=='object'||Array.isArray(p.data))return json(res,400,{code:'invalid_admin_command'});
     return json(res,200,await call('select svitlo_admin.command($1,$2,$3,$4,$5,$6::jsonb) value',[proof,p.requestId,p.kind,p.target,p.reason,JSON.stringify(p.data)]));
    }
    return json(res,404,{code:'not_found'});
   }
   if(!['GET','HEAD'].includes(req.method))return json(res,405,{code:'method_not_allowed'});
   const requested=decodeURIComponent(u.pathname),file=resolve(root,requested==='/'?'index.html':requested.slice(1));if(!file.startsWith(root+'/')&&!file.startsWith(root+'\\'))return json(res,404,{code:'not_found'});
   const bytes=await readFile(file);res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(e){const status=e.status||(['42501'].includes(e.code)?403:['22P02','P0001','23503'].includes(e.code)?400:e.code==='ENOENT'?404:503);json(res,status,{code:status===403?'admin_role_rejected':status===400?'invalid_admin_command':status===404?'not_found':'admin_temporarily_unavailable'});
  }finally{if(admitted)inFlight--;}
 });
}
