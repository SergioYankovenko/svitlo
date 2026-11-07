import test from 'node:test';
import assert from 'node:assert/strict';
import {advance,condition,send} from './source-alerts.mjs';
import {civil} from '../../app/lib/time.js';

const date='2026-11-07',now=civil(date,12*60),slot=now-now%300000;
const healthy={slot,value:{checkedAt:now,plans:[{date,uncertain:false}]}};

test('alerts detect transport failures and malformed subgroup data without treating missing publications as errors',()=>{
  assert.equal(condition('cherkasy',{...healthy,error:'forbidden'},now),'forbidden');
  assert.equal(condition('cherkasy',{slot,value:{...healthy.value,plans:[{date,uncertain:true}]}},now),'unconfirmed_subgroup_format');
  assert.equal(condition('cherkasy',{slot,value:{...healthy.value,plans:[]}},now),null);
  assert.equal(condition('cherkasy',healthy,now+450001),'missed_cycle');
  const malformed={slot,value:{flags:{showTableFact:true},fact:{update:'07.11.2026 12:00',data:{[civil(date)/1000]:{'GPV1.1':{'1':'no'}}}}}};
  assert.equal(condition('dtek-kyiv',malformed,now),'invalid_subgroup_format');
  assert.equal(condition('dtek-kyiv',{slot,value:{flags:{showTableFact:false}}},now),null);
});

test('first active problem is queued, repeats collapse and recovery survives the next cycle',()=>{
  const error={...healthy,error:'invalid_response'};
  let state={sources:{},pending:[]};
  advance(state,{cherkasy:error},now,false);
  assert.equal(state.pending.length,0);
  advance(state,{cherkasy:error},now,true);
  state=JSON.parse(JSON.stringify(state));
  advance(state,{cherkasy:{...error,slot:slot+300000}},now+300000,true);
  assert.deepEqual(state.pending.map(x=>x.issue),['invalid_response']);
  advance(state,{cherkasy:{...healthy,slot:slot+600000}},now+600000,true);
  assert.deepEqual(state.pending.map(x=>x.issue),['invalid_response',null]);
});

test('Telegram confirms the configured recipient and rate limits use retry_after without exposing the token',async()=>{
  const config={token:'test-secret',chatId:'12345'};
  await send(config,'safe text',async(url,options)=>{
    assert.equal(new URL(url).host,'api.telegram.org');
    assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{chat_id:'12345',text:'safe text',link_preview_options:{is_disabled:true}});
    return Response.json({ok:true,result:{chat:{id:12345}}});
  });
  await assert.rejects(()=>send(config,'safe',async()=>Response.json({ok:false,parameters:{retry_after:17}},{status:429})),
    error=>error.retry===17000&&!String(error).includes(config.token));
  await assert.rejects(()=>send(config,'safe',async()=>Response.json({ok:true,result:{chat:{id:99999}}})),/telegram_delivery_failed/);
});
