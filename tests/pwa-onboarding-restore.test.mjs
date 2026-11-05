import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../pwa/onboarding.js',import.meta.url),'utf8');
const record=(n,name)=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,name});
const selected={city:record(1,'м. Христинівка'),street:record(2,'вул. О.Береста'),house:record(3,'49')};
function setup(){
  const state={catalogSource:'live',target:'pwa',scenario:'live',addresses:[],onboardingDraft:{source:'live',initial:true,phase:'address',selected:structuredClone(selected),...Object.fromEntries(Object.entries(selected).map(([k,v])=>[k,v.id])),queries:{city:'',street:'',house:''},inlineReview:true}};
  const requests=[];
  const window={SvitloLive:{search:(kind,flow,q)=>{requests.push({kind,q});return new Promise(()=>{});}}};
  const document={getElementById:()=>null,querySelector:()=>null};
  let seq=0;const timers=new Map();
  const context=vm.createContext({window,document,navigator:{onLine:true},AbortController,queueMicrotask:()=>{},setTimeout:f=>(timers.set(++seq,f),seq),clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  const ctx={getState:()=>state,save:()=>{},render:()=>{},closeDialog:()=>{}};
  return {state,requests,tick:()=>[...timers.values()].forEach(f=>f()),create:()=>window.SvitloOnboarding.create(ctx)};
}
for(const kind of ['city','street','house'])test(`reload during ${kind} edit retains the previous full choice and collapses back to it`,()=>{
  const {state,create}=setup();let flow=create();assert.equal(flow.restore(),true);
  flow.handleAction('onboard-edit-kind',{dataset:{kind}});
  assert.equal(state.onboardingDraft.selected[kind],null);
  flow.suspend();state.onboardingDraft=JSON.parse(JSON.stringify(state.onboardingDraft));
  flow=create();assert.equal(flow.restore(),true);
  flow.handleAction('onboard-edit-kind',{dataset:{kind}});
  for(const key of Object.keys(selected))assert.deepEqual(JSON.parse(JSON.stringify(state.onboardingDraft.selected[key])),selected[key]);
  assert.equal(state.onboardingDraft.editing,null);
  flow.close();
});
test('corrupt backup record cannot replace a current field',()=>{
  const {state,create}=setup();let flow=create();flow.restore();flow.handleAction('onboard-edit-kind',{dataset:{kind:'street'}});flow.suspend();
  state.onboardingDraft.editBackup.selected.street.id='invalid';
  flow=create();assert.equal(flow.restore(),true);flow.suspend();assert.equal(state.onboardingDraft.editBackup,null);
});
test('same-owner additional draft can restore before the profile cache has loaded',()=>{
  const {state,create}=setup();state.onboardingDraft.initial=false;state.liveOwner='11111111-1111-4111-8111-111111111111';
  const flow=create();assert.equal(flow.restore(),true);flow.suspend();assert.equal(state.onboardingDraft.initial,false);
});
test('an additional draft without an owner or saved addresses is discarded',()=>{
  const {state,create}=setup();state.onboardingDraft.initial=false;
  assert.equal(create().restore(),false);assert.equal(state.onboardingDraft,undefined);
});
for(const kind of ['city','street','house'])test(`${kind} clearing follows the approved city minimum or parent list rule`,()=>{
 const {create,requests,tick}=setup(),flow=create();flow.restore();flow.handleAction('onboard-edit-kind',{dataset:{kind}});
 const before=requests.length;
 for(const value of ['', '   '])flow.handleInput({target:{dataset:{onboardQuery:kind},value,hasAttribute:()=>false}});
 tick();assert.equal(requests.length,before+(kind==='city'?0:1));
 const afterClear=requests.length;
 const value=kind==='city'?'Ки':kind==='house'?'1':'М';
 flow.handleInput({target:{dataset:{onboardQuery:kind},value,hasAttribute:()=>false}});tick();
 assert.equal(requests.at(-1).q,value);assert.equal(requests.length,afterClear+1);flow.close();
});
