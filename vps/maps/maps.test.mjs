import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {candidates,finalCandidate,normalHouse,streetRelation,inputAddress} from './policy.js';
import {MapAddresses,mapOnlySnapshot} from './service.js';
import {VisicomConnector,callVisicom} from './connector.js';
import {validProfile} from '../../app/lib/cache-data.js';
import {validateRequest} from '../telemetry/validation.js';
import {sensorSignalView} from '../../app/lib/map-sensor.js';
const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/'+name+'.json',import.meta.url),'utf8'));
const cityId='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222';
const city={id:cityId,name:'Христинівка',region:'Черкаська область',settlementId:'STL1NYKCD',type:'місто'};
const address=(street='Івана Богуна',house='8/а')=>({cityId,street,house});
const houseLocation=()=>{const i=address();return finalCandidate(fixture('bohuna-house'),candidates(fixture('bohuna-search'),i,city)[0],i,city,1000);};
function service({existing=false,allowed=true,connector={lookup:async()=>[houseLocation()]},now=()=>1000}={}){
 let external=0;
 const bridge={query:async(sql)=>({rows:sql.includes('city_routes')?[{operator_id:'ua-cherkasy',provider_key:'["18", "801"]',state:'available'}]:sql.includes('join svitlo_vps.catalog s')?(existing?[{id:'existing',label:'8/а',street:'Івана Богуна'}]:[]):sql.includes('take_budget')?[{allowed}]:[]})};
 const maps=new MapAddresses({bridge,catalog:{entity:async()=>({id:cityId,kind:'city',label:'м. Христинівка',metadata:{}})},secret:'test-map-secret',connector:{lookup:async(...args)=>{external++;return connector.lookup(...args);}},now});
 return {maps,get calls(){return external;}};
}
test('full letters and numeric fractions survive formatting; only slash-before-letter normalizes',()=>{assert.equal(normalHouse('8/а'),'8а');assert.equal(normalHouse('10а/51'),'10а/51');assert.notEqual(normalHouse('10а/51'),normalHouse('10'));});
test('captured mixed-town search retains Khrystynivka 8а and rejects Kaniv',()=>{const result=candidates(fixture('bohuna-search'),address(),city);assert.equal(result.length,1);assert.equal(result[0].precision,'house');assert.equal(result[0].matchedHouse,'8а');assert.equal(result[0].featureId,'ADR3KIJY5CHR3S43BJ');});
test('captured Floreshtska 10а/51 resolves only to the street and preserves typed house separately',()=>{const i=address('Флорештська','10а/51'),result=candidates(fixture('floreshtska-search'),i,city);assert.equal(result[0].precision,'street');assert.equal(result[0].matchedHouse,null);const final=finalCandidate(fixture('floreshtska-street'),result[0],i,city,1000);assert.equal(final.precision,'street');assert.equal(i.house,'10а/51');});
test('same address at different coordinates deduplicates into one candidate',()=>{const raw=fixture('bohuna-search'),f=raw.features.find(f=>f.properties.settlement==='Христинівка'),other=structuredClone(f);other.id+='A';other.geo_centroid.coordinates[0]+=.001;assert.equal(candidates({type:'FeatureCollection',features:[f,other]},address(),city).length,1);});
test('street/lane and another named person are not silently merged',()=>{assert.equal(streetRelation('пров. Івана Богуна','вул. І. Богуна','STL1NYKCD'),null);assert.equal(streetRelation('Миколи Терещенка','Н. Терещенка','STL1NYKCD'),null);});
test('short surname request keeps explicitly selectable candidates in the same settlement',()=>{assert.equal(candidates(fixture('bohuna-search'),address('Богуна'),city)[0].featureId,'ADR3KIJY5CHR3S43BJ');});
test('a final selected object losing its house letter is rejected',()=>{const raw=fixture('bohuna-house'),c=candidates(fixture('bohuna-search'),address(),city)[0];raw.properties.name='8';assert.throws(()=>finalCandidate(raw,c,address(),city,1000));});
test('an implausible number plus a real street remains approximate',()=>{const i=address('Флорештська','99999');assert.equal(candidates(fixture('floreshtska-search'),i,city)[0].precision,'street');});
test('existing exact provider address avoids external map access',async()=>{const s=service({existing:true});assert.equal((await s.maps.search(owner,address())).state,'provider_found');assert.equal(s.calls,0);});
test('successful missing lookup allows owner-bound candidates and original house',async()=>{const s=service(),r=await s.maps.search(owner,address());assert.equal(s.calls,1);const p=s.maps.open(owner,r.candidates[0].token);assert.equal(p.input.house,'8/а');assert.equal(p.location.matchedHouse,'8а');});
test('provider lookup failure is not converted into missing or an external call',async()=>{const s=service();s.maps.providerAddress=async()=>{throw Error('database unavailable');};await assert.rejects(()=>s.maps.search(owner,address()));assert.equal(s.calls,0);});
test('budget rejection avoids map traffic',async()=>{const s=service({allowed:false});await assert.rejects(()=>s.maps.search(owner,address()),e=>e.status===429);assert.equal(s.calls,0);});
test('expired, altered, cross-owner and invalid-byte proofs fail closed',()=>{let now=1000;const {maps}=service({now:()=>now});const token=maps.token(owner,address(),houseLocation());assert.throws(()=>maps.open('foreign',token));assert.throws(()=>maps.open(owner,token.slice(0,-1)+'!'));assert.throws(()=>maps.open(owner,token.split('.')[0]+'.'+'а'.repeat(43)));now=601001;assert.throws(()=>maps.open(owner,token));});
test('control characters and excessive input are rejected but apostrophes remain data',()=>{assert.throws(()=>inputAddress(address('bad\ninput')));assert.throws(()=>inputAddress(address('a'.repeat(161))));assert.equal(inputAddress(address("В'ячеслава Чорновола")).street,"В'ячеслава Чорновола");});
test('client cannot submit fabricated map metadata or combine a proof with a provider ID',()=>{assert.throws(()=>validateRequest('/api',{action:'save',address:{mapOnly:true}}));assert.throws(()=>validateRequest('/api',{action:'save',address:{mapCandidateToken:'x',canonicalAddressId:cityId}}));validateRequest('/api',{action:'save',address:{mapCandidateToken:'proof'},confirmed:true});});
test('map-only snapshot has neither queue nor false clear schedule and persists in the client cache',()=>{const a={...address(),department:'map:visicom',city:'Христинівка',mapOnly:true,operatorId:'map-only',canonicalAddressId:cityId,lineId:null,mapLocation:houseLocation()},snapshot=mapOnlySnapshot(a);assert.equal(snapshot.queue,null);assert.equal(snapshot.queueResolution.inclusion,undefined);assert.equal(snapshot.checkedAt,0);assert.equal(snapshot.plans.length,0);assert(validProfile({id:'p',owner,address:a,snapshot},owner));});
test('bounded spelling retry finds 8а without overwriting 8/а',async()=>{const queries=[];const connector=new VisicomConnector({now:()=>1000,call:async(op,args)=>{if(op==='getFeature')return fixture('bohuna-house');queries.push(args.query);return queries.length===1?{}:fixture('bohuna-search');}});const i=address(),r=await connector.lookup(i,city);assert.equal(queries.length,2);assert(queries[0].includes('8/а'));assert(queries[1].includes('8а'));assert.equal(i.house,'8/а');assert.equal(r[0].precision,'house');});
test('real pinned api-anything starts its own anonymous session and executes only installed allowlisted reads',async()=>{
 const paths=[];const result=await callVisicom('searchAddress',{query:'frozen public fixture'},5000,async(url,init)=>{const u=new URL(url);paths.push(u.pathname);assert.equal(u.hostname,'maps.visicom.ua');assert.equal(init.redirect,'manual');
  if(u.pathname==='/')return new Response('<html><title>Public map</title></html>',{headers:{'content-type':'text/html','set-cookie':'timestamp=123456; Path=/; Secure'}});
  assert.match(init.headers.cookie,/timestamp=123456/);return new Response(JSON.stringify(fixture('bohuna-search')),{headers:{'content-type':'application/json'}});
 });assert.deepEqual(paths,['/','/uk/fts']);assert.equal(result.type,'FeatureCollection');
});
test('map sensor UI expires a confirmed state and never turns missing transport into off',()=>{
 const now=Date.now(),signal={serverTime:new Date(now).toISOString(),lastConfirmedAt:new Date(now-10000).toISOString(),lastReceivedAt:new Date(now).toISOString(),freshnessSeconds:180,availability:'available',freshness:'fresh',transportState:'online',clockQuality:'synchronized',powerState:'on'};
 assert.equal(sensorSignalView(signal).state,'on');assert.equal(sensorSignalView({...signal,powerState:'off'}).state,'off');assert.equal(sensorSignalView(signal,171000).state,'unknown');assert.equal(sensorSignalView({...signal,transportState:'offline',powerState:'off'}).state,'unknown');assert.equal(sensorSignalView(null).state,'unknown');
});
