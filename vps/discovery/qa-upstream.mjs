// Explicit node --import fixture, usable only by the disposable HTTP integration suite.
if(!/^svitlo_discovery_qa_\d+$/.test(process.env.PGDATABASE||''))throw Error('Disposable discovery QA database required');
// The real operator adapter uses its own Undici dispatcher, so replacing global
// fetch alone does not isolate it. Replace only this module in the explicit QA
// child process; production TLS/CA handling is left byte-for-byte unchanged.
const {registerHooks}=await import('node:module');
const operatorModule=new URL('../operator-fetch.js',import.meta.url).href;
registerHooks({load(url,context,nextLoad){return url===operatorModule?{format:'module',source:'export const operatorFetch=(...args)=>globalThis.fetch(...args);',shortCircuit:true}:nextLoad(url,context);}});
const realFetch=globalThis.fetch;const {loadBundle}=await import('../geography/bundle.mjs');const {data}=await loadBundle();
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url||String(input));if(['127.0.0.1','localhost'].includes(url.hostname))return realFetch(input,options);
 if(url.hostname==='cabinet.cherkasyoblenergo.com'){
  const op=url.searchParams.get('op');let result;
  if(op==='department_list')result=[...new Map(data.routes.filter(r=>r.operatorId==='ua-cherkasy').map(r=>[r.branchId,{ID:r.branchId,NAME:r.branchName}])).values()];
  else if(op==='city_list')result=data.routes.filter(r=>r.operatorId==='ua-cherkasy'&&r.branchId===url.searchParams.get('dept_id')).map(r=>({ID:r.providerCityId,NAME:r.providerCityName}));
  else if(op==='street_list')result=[{ID:'geo-qa-street',NAME:'вул. Діагностична QA'}];
  else if(op==='house_list')result=['8/а','10а/51','25'].map(HOUSE=>({HOUSE}));
  else if(op==='ls_list_by_addr')result=[];
  else if(op==='disconn_by_dept')result={DISCONNECTIONS:[],DISCONN_QUEUQ:[]};
  else throw Error('Unspecified isolated Cherkasy fixture');
  return Response.json(result);
 }
 throw Error('Outbound fetch is disabled in isolated discovery HTTP QA');
};
