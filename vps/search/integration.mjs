// Disposable search/PG pilot. No profiles, accounts, operator requests or payments.
import pg from 'pg';import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {prepareSearchFixture,poolFor} from './fixture.mjs';import {MeiliClient} from './meili.js';import {SearchIndexer} from './indexer.js';import {AddressSearch} from './service.js';
import {DictionarySearch,DictionaryIndexer} from './dictionary.js';
const database=process.env.PGDATABASE;if(!/^svitlo_search_qa_\d+$/.test(database||''))throw Error('Disposable search QA database required');
const config={host:process.env.PGHOST||'postgres',user:'svitlo_owner',database,password:process.env.CI==='true'?'isolated-history-ci':(await readFile('/run/secrets/owner_password','utf8')).trim(),options:'-c statement_timeout=30000 -c lock_timeout=5000'};
const c=new pg.Client(config),api=new pg.Client(config);await c.connect();await api.connect();const fixture={exec:sql=>c.query(sql),query:(...args)=>c.query(...args)};
const client=new MeiliClient({url:process.env.MEILI_URL||'http://127.0.0.1:7700',key:process.env.MEILI_MASTER_KEY||'isolated-search-ci-only'});
try{
 await prepareSearchFixture(fixture,{createRoles:false,installSearch:false});
 // Optional full stored public catalogue. Only explicitly whitelisted public
 // fields are exported by the pilot runner, never source rows or user records.
 if(process.env.SEARCH_PUBLIC_DATA_FILE){
  const lines=(await readFile(process.env.SEARCH_PUBLIC_DATA_FILE,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const ops=[...new Set(lines.map(x=>x.operator_id).filter(Boolean))];
  for(const id of ops)await c.query("insert into svitlo_vps.operators(id,adapter_key,label,state) values($1,'fixture-v1',$1,'available') on conflict do nothing",[id]);
  for(const kind of ['city','street','address']){const rows=lines.filter(r=>r.kind===kind);for(let offset=0;offset<rows.length;offset+=500)await c.query(`insert into svitlo_vps.catalog(id,kind,parent_id,label,operator_id,metadata,source_ref)
   select id,kind,parent_id,label,operator_id,metadata,source_ref from jsonb_to_recordset($1::jsonb) x(id uuid,kind text,parent_id uuid,label text,operator_id text,metadata jsonb,source_ref jsonb)`,[JSON.stringify(rows.slice(offset,offset+500))]);}
  const redirects=lines.filter(r=>r.redirect_to);for(let offset=0;offset<redirects.length;offset+=500)await c.query('update svitlo_vps.catalog e set redirect_to=x.redirect_to from jsonb_to_recordset($1::jsonb) x(id uuid,redirect_to uuid) where e.id=x.id',[JSON.stringify(redirects.slice(offset,offset+500))]);
 }
 const city=randomUUID(),other=randomUUID();await c.query("insert into svitlo_vps.catalog(id,kind,label) values($1,'city','Пілот · Київ'),($2,'city','Пілот · інша громада')",[city,other]);
 const names=['вул. Шевченка','просп. Перемоги','вул. Незалежності','вул. Лесі Українки','вул. Січових Стрільців','пров. Сонячний','вул. Вишнева','вул. Зелена','вул. Лісова','вул. Миру','пров. Київський','вул. Соборна','вул. Польова','вул. Садова','вул. Грушевського','вул. Козацька','вул. Молодіжна','вул. Паркова','вул. Європейська','пров. Шевченка'];
 const labels=['10','10А','10/1','101','10 корпус 1','10 корпус 2','10 а','10a','12-Б','12/2'];const corpus=[];let firstStreet;
 for(const [n,name] of names.entries()){
  const street=randomUUID(),duplicate=randomUUID();if(!n)firstStreet=street;
  await c.query("insert into svitlo_vps.catalog(id,kind,parent_id,label) values($1,'street',$3,$4),($2,'street',$5,$4)",[street,duplicate,city,name,other]);
  for(const label of labels){const id=randomUUID();await c.query("insert into svitlo_vps.catalog(id,kind,parent_id,label,operator_id) values($1,'address',$2,$3,'fixture-op')",[id,street,label]);corpus.push({parentId:street,query:label==='10А'?'10а':label,id});}
 }
 await c.query(await readFile(new URL('../sql/address-search.sql',import.meta.url),'utf8'));
 await c.query('set role svitlo_stage_worker');await api.query('set role svitlo_stage_api');
 const indexer=new SearchIndexer({pool:poolFor(c),client}),settle=async()=>{for(let i=0;i<3000;i++){const state=await indexer.tick();if(state.state==='idle')return;}throw Error('Index failed to settle');};
 const started=performance.now();await settle();
 const generation=(await c.query('select active_generation from svitlo_search.control')).rows[0].active_generation;
 const indexMs=performance.now()-started,latencies=[];let checks=0;
 for(const item of corpus){const at=performance.now(),result=await client.search(generation,{kind:'address',parentId:item.parentId,q:item.query,limit:50});latencies.push(performance.now()-at);assert.deepEqual(result.ids,[item.id]);checks++;}
 const port=new AddressSearch({bridge:{query:(...args)=>api.query(...args)},client,secret:'isolated-search-cursor'});
 for(const q of ['Шевченк','Шевченко','Незалежнос','Січових Стрільц','Грушевськ']){
  const result=await port.search({kind:'street',parentId:city,q,limit:50});assert.ok(result?.rows.length,'Fuzzy query must return a scoped candidate: '+q);assert.ok(result.rows.every(r=>r.parent_id===city));checks++;
 }
 const home=corpus[0];const exact=await port.search({kind:'address',parentId:home.parentId,q:'10',limit:50});assert.deepEqual(exact.rows.map(r=>r.id),[home.id]);checks++;
 await c.query('reset role');await c.query('select svitlo_search.create_generation($1)',['svitlo_catalog_g_corpusnext01']);await c.query('set role svitlo_stage_worker');
 let renamed=false;const upsert=client.upsert.bind(client);client.upsert=async(...args)=>{if(!renamed){renamed=true;await c.query('reset role');await c.query("update svitlo_vps.catalog set label='99/2' where id=$1",[home.id]);await c.query('set role svitlo_stage_worker');}return upsert(...args);};
 await settle();checks++;
 const after=await port.search({kind:'address',parentId:home.parentId,q:'99/2',limit:50});assert.deepEqual(after.rows.map(r=>r.id),[home.id]);checks++;
 // Prove source/database fallback remains available when the optional engine is down.
 const unavailable=new AddressSearch({bridge:{query:(...args)=>api.query(...args)},client:{anchor:async()=>false},secret:'isolated-search-cursor'});
 assert.equal(await unavailable.search({kind:'street',parentId:city,q:'never-exact-query',limit:50}),null);checks++;
 await c.query('reset role');await c.query('create table svitlo_geo.routes(id text primary key,operator_id text,active boolean);create table svitlo_geo.route_places(route_id text,settlement_code text)');
 await c.query(await readFile(new URL('../sql/dictionary-search.sql',import.meta.url),'utf8'));
 await c.query("insert into svitlo_vps.operators(id,adapter_key,label,state) values('ua-cherkasy','cherkasy-v1','Dictionary fixture','available') on conflict do nothing");
 const dictionaryCity=randomUUID();await c.query("insert into svitlo_vps.catalog(id,kind,label,operator_id) values($1,'city','Dictionary city','ua-cherkasy')",[dictionaryCity]);
 await c.query("insert into svitlo_geo.routes values('dictionary-fixture','ua-cherkasy',true);insert into svitlo_geo.route_places values('dictionary-fixture','UAfixture')");
 const dictionary=new DictionarySearch({bridge:api,client,secret:'isolated-dictionary'}),scope=dictionary.scope('dictionary-fixture','UAfixture','street',dictionaryCity);
 await dictionary.stage({route:'dictionary-fixture',settlement:'UAfixture',kind:'street',parent:dictionaryCity,rows:names.map((name,i)=>({id:'street-'+i,name}))});
 await c.query('set role svitlo_stage_worker');await new DictionaryIndexer({pool:poolFor(c),client,secret:'isolated-dictionary'}).tick();
 const found=await dictionary.search({scope,q:'Шевченко',kind:'street',limit:50});assert.ok(found?.page.some(x=>x.id==='street-0'));checks++;
 const page=await dictionary.search({scope,q:'',kind:'street',limit:1});assert.equal(page.page.length,1);assert.ok(page.nextCursor);checks++;
 assert.equal((await dictionary.search({scope,q:'',kind:'street',limit:1,cursor:page.nextCursor})).page.length,1);checks++;
 // An engine restart/lost volume must restore settings as well as documents.
 await settle();const active=(await c.query('select active_generation from svitlo_search.control')).rows[0].active_generation;
 await client.request(client.index(active),{method:'DELETE'}).then(t=>client.wait(t));indexer.configuredAt.set(active,0);await settle();
 assert.deepEqual((await client.search(active,{kind:'address',parentId:home.parentId,q:'99/2',limit:50})).ids,[home.id]);checks++;
 await c.query('reset role');const stored=(await c.query('select count(*)::int n from svitlo_vps.catalog')).rows[0].n;
 latencies.sort((a,b)=>a-b);const report={scope:'meilisearch-postgresql-corpus',checks,exactHouseCases:corpus.length,catalogRows:stored,initialIndexMs:Math.round(indexMs),engineP95Ms:Math.round(latencies[Math.floor(latencies.length*.95)]*100)/100,rebuildUnderWrite:true,optionalDependencyFailure:true,syntheticOnly:!process.env.SEARCH_PUBLIC_DATA_FILE,privateTablesRead:false};
 if(process.env.SEARCH_REPORT_FILE)await writeFile(process.env.SEARCH_REPORT_FILE,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await api.end();await c.end();}
