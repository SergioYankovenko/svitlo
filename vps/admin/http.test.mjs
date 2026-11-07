import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';import {createAdminServer} from './server.js';
const fetch=(url,{method='GET',headers,body}={})=>new Promise((resolve,reject)=>{const r=http.request(url,{method,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,json:async()=>JSON.parse(Buffer.concat(chunks))}));});r.on('error',reject);r.end(body);});
test('admin HTTP rejects main-app credentials, wrong origins, missing CSRF, and unbounded/generic operations',async()=>{
 const calls=[],token='c'.repeat(64),principal={id:'administrator',roles:['read-only']};let origin;
 const pool={async query(sql,args){calls.push({sql,args});return {rows:[{value:sql.includes('.principal(')?principal:sql.includes('.list(')?{data:[],total:0}:true}]};}};
 const temporary=createAdminServer({pool,secret:'a'.repeat(64),origin:'http://127.0.0.1:18768'});assert.throws(()=>createAdminServer({pool,secret:'a'.repeat(64),origin:'http://admin.invalid'}));temporary.close();
 const server=createAdminServer({pool,secret:'a'.repeat(64),origin:'http://127.0.0.1:18768'});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port,headers={Host:'127.0.0.1:18768'};
 try{
  assert.equal((await fetch(base+'/api/admin/session',{headers:{...headers,Cookie:'svitlo_stage='+token}})).status,401);
  const session=await (await fetch(base+'/api/admin/session',{headers:{...headers,Cookie:'svitlo_admin='+token}})).json();assert.equal(session.csrf.length,64);
  const post=async(path,data,extra={})=>fetch(base+'/api/admin/'+path,{method:'POST',headers:{...headers,Cookie:'svitlo_admin='+token,Origin:'http://127.0.0.1:18768','Content-Type':'application/json',...extra},body:JSON.stringify(data)});
  assert.equal((await post('list',{resource:'sources',page:1,perPage:25})).status,403);
  assert.equal((await post('list',{resource:'sources',page:1,perPage:25},{'X-Svitlo-Admin-CSRF':session.csrf,Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await post('list',{resource:'sources',page:1,perPage:1000},{'X-Svitlo-Admin-CSRF':session.csrf})).status,400);
  assert.equal((await post('list',{resource:'sources',page:1,perPage:25},{'X-Svitlo-Admin-CSRF':session.csrf})).status,200);
  assert.equal((await post('sql',{query:'select secret'},{'X-Svitlo-Admin-CSRF':session.csrf})).status,404);
  assert.ok(calls.every(x=>!x.sql.includes('select secret')));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
