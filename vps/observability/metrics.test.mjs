import test from 'node:test';import assert from 'node:assert/strict';
import {createMetrics,metricsToken,permitsMetrics,observeClient} from './metrics.js';
test('metrics authentication and route cardinality exclude arbitrary address, owner and query data',async()=>{
 const m=createMetrics();m.http('/api/v1/search',200,.1);m.http('/api/secret-home?owner=private',400,.2);
 m.operations({generatedSeconds:100,jobs:{ready:2},oldestPendingSeconds:8,lastCycleSeconds:90});
 const text=await m.registry.metrics();assert.ok(text.includes('route="unknown_api"'));assert.ok(!text.includes('secret-home'));assert.ok(!text.includes('private'));
 assert.ok(text.includes('svitlo_operations_generated_seconds 100'));
 const token=metricsToken('server-secret');assert.ok(permitsMetrics('Bearer '+token,'server-secret'));
 for(const h of [null,'Bearer '+token+'x','Basic '+token,'Bearer '+token.toUpperCase(),'Bearer '+metricsToken('other')])assert.equal(permitsMetrics(h,'server-secret'),false);
});
test('SQL instrumentation preserves promises, callback results, throws and transaction client behavior',async()=>{
 const rows=[],observer={sql:(...x)=>rows.push(x)};
 const client={query(sql,cb){if(sql==='throw')throw Error('private-query');if(cb){cb(null,{value:1});return 'callback-result';}return sql==='fail'?Promise.reject(Error('secret')):Promise.resolve({value:2});}};
 observeClient(client,'worker',observer);observeClient(client,'worker',observer);
 assert.deepEqual(await client.query('begin'),{value:2});assert.equal(client.query('callback',(e,r)=>assert.equal(r.value,1)),'callback-result');
 await assert.rejects(()=>client.query('fail'));assert.throws(()=>client.query('throw'));
 assert.equal(rows.length,4);assert.deepEqual(rows.map(r=>r.slice(0,2)),[['worker','ok'],['worker','ok'],['worker','error'],['worker','error']]);
 assert.ok(!JSON.stringify(rows).includes('secret'));
});
