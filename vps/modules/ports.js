// Runtime-checked boundaries; replacement adapters must satisfy the same port.
export const portDefinitions=Object.freeze({
 AddressCatalog:['capabilities','search','resolve','legacy'],ScheduleService:['batch','snapshot'],Profiles:['handle'],PlanningService:['windows','next','key'],
 IdentityProvider:['verify'],BillingProvider:['lookup','acknowledge'],NotificationChannel:['send'],
 ObjectStorage:['put','get','remove'],JobQueue:['claim','database','external','fail'],
 ChargeCatalog:['viewport','station'],AvailabilityForecast:['forecast']
});
export function port(name,implementation){
 const methods=portDefinitions[name];if(!methods)throw Error('Unknown module port');
 if(!implementation||methods.some(m=>typeof implementation[m]!=='function'))throw Error('Invalid '+name+' implementation');
 return Object.freeze(Object.fromEntries(methods.map(m=>[m,implementation[m].bind(implementation)])));
}
export function corePorts({reader,service,planning}){
 return Object.freeze({catalog:port('AddressCatalog',{capabilities:()=>reader.capabilities(),search:p=>reader.catalog.search(p),resolve:p=>reader.resolve(p),legacy:p=>reader.catalog.legacy(p)}),
  schedules:port('ScheduleService',{batch:p=>reader.batch(p),snapshot:(...p)=>reader.snapshot(...p)}),profiles:port('Profiles',service),...(planning?{planning:port('PlanningService',planning)}:{})});
}
export const domainStates=Object.freeze(['available','degraded','stale','unknown','blocked','captcha','quota_exceeded','rate_limited','unsupported','not_configured']);
export function dependencyState(e){
 if(e?.code==='forbidden'||e?.code==='operator_paused')return 'blocked';if(e?.code==='captcha'||e?.code==='challenge_required')return 'captcha';
 if(e?.code==='daily_quota_exceeded')return 'quota_exceeded';if(e?.code==='rate_limited'||e?.status===429)return 'rate_limited';
 if(e?.code==='adapter_unsupported')return 'unsupported';if(e?.code?.endsWith('_not_configured'))return 'not_configured';return 'degraded';
}
