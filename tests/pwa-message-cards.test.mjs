import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=(await readFile(new URL('../pwa/live-messages.js',import.meta.url),'utf8')).replaceAll("'./core/",`'${new URL('../app/',import.meta.url).href}`);
const {visibleMessages}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const publication={id:'first',kind:'schedule',revisionType:'publication',date:'2026-11-05',queue:'21.1',addressId:'a',lineId:'line',publishedAt:1793828520000,title:'Графік на 5 листопада',url:'https://example.org/source'};
test('repeated first publication IDs produce one card without changing history',()=>{
 const messages=[publication,{...publication,id:'other-day',date:'2026-11-04'},{...publication,id:'retry'}],before=JSON.stringify(messages);
 assert.deepEqual(visibleMessages(messages).map(m=>m.id),['first','other-day']);assert.equal(JSON.stringify(messages),before);
});
test('real revisions, sources, times, addresses, lines and special events remain independent',()=>{
 for(const patch of [{revisionType:'change'},{publishedAt:publication.publishedAt+60000},{addressId:'b'},{lineId:'other'},{scope:'region'},{url:'https://example.org/other'},{special:true},{planSignature:'changed'},{kind:'emergency'}])
  assert.equal(visibleMessages([publication,{...publication,id:'second',...patch}]).length,2,JSON.stringify(patch));
 const a={...publication,revisionType:'change'},b={...a,id:'different-revision'};assert.equal(visibleMessages([a,b]).length,2);
});
test('exact repeated IDs collapse while undated and unknown messages are retained',()=>{
 assert.deepEqual(visibleMessages(null),[]);assert.deepEqual(visibleMessages({}),[]);
 assert.equal(visibleMessages([publication,publication]).length,1);
 assert.equal(visibleMessages([{...publication,publishedAt:null},{...publication,id:'second',publishedAt:null}]).length,2);
});
