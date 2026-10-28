import {validDate} from './lifecycle.js';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const time=x=>Number.isFinite(x)&&x>=0;
const event=e=>object(e)&&['hourly','planned','emergency'].includes(e.category)&&(e.unplanned===undefined||typeof e.unplanned==='boolean')&&time(e.start)&&(e.end===null||time(e.end)&&e.end>=e.start);
export function validProfile(p,owner) {
  if(!object(p)||p.owner!==owner||typeof p.id!=='string'||!p.id||!object(p.address)||!object(p.snapshot))return false;
  const a=p.address,s=p.snapshot;
  if(!['department','cityId','city'].every(k=>typeof a[k]==='string'&&a[k]))return false;
  if(a.label!==undefined&&typeof a.label!=='string'||p.name!==undefined&&typeof p.name!=='string')return false;
  if(s.categories!==undefined&&!object(s.categories)||s.failures!==undefined&&!Array.isArray(s.failures))return false;
  for(const c of Object.values(s.categories||{}))if(!object(c)||c.events!==undefined&&(!Array.isArray(c.events)||!c.events.every(event)))return false;
  if(s.plans!==undefined&&(!Array.isArray(s.plans)||!s.plans.every(p=>object(p)&&validDate(p.date)&&Array.isArray(p.events)&&p.events.every(event))))return false;
  if(s.emergencies!==undefined&&(!Array.isArray(s.emergencies)||!s.emergencies.every(e=>object(e)&&Array.isArray(e.queues)&&time(e.effectiveAt)&&time(e.publishedAt))))return false;
  if(p.messages!==undefined&&(!Array.isArray(p.messages)||!p.messages.every(m=>object(m)&&typeof m.id==='string'&&validDate(m.date))))return false;
  return true;
}
export const normalizeProfile=p=>({...p,address:{...p.address,label:p.address.label||[p.address.city,p.address.street,p.address.house].filter(Boolean).join(', ')}});
export function validWeather(w,now){
  return object(w)&&time(w.checkedAt)&&w.checkedAt<=now+300000&&Number.isFinite(w.temperature)&&Number.isFinite(w.code)&&
    (w.hours===undefined||Array.isArray(w.hours)&&w.hours.every(h=>object(h)&&time(h.time)&&Number.isFinite(h.temp)&&Number.isFinite(h.code)));
}
export function envelopeData(value,owner,now) {
  if(!object(value)||value.owner!==owner||![undefined,1].includes(value.version)||!Array.isArray(value.profiles)||value.profiles.length>10||
    !value.profiles.every(p=>validProfile(p,owner))||new Set(value.profiles.map(p=>p.id)).size!==value.profiles.length)return null;
  const cities=new Map(value.profiles.map(p=>[JSON.stringify([p.address.department,p.address.cityId,p.address.city]),p.address.city]));
  const invalidWeather=Object.entries(object(value.weather)?value.weather:{}).some(([k,w])=>!validWeather(w,now)||!cities.has(k)||w.city!==cities.get(k));
  const weather=Object.fromEntries(Object.entries(object(value.weather)?value.weather:{}).filter(([k,w])=>validWeather(w,now)&&cities.has(k)&&w.city===cities.get(k)).map(([k,w])=>[k,{...w,hours:w.hours||[]}]));
  return {...value,version:1,profiles:value.profiles.map(normalizeProfile),weather,
    outageTypeAttempts:Object.fromEntries(Object.entries(object(value.outageTypeAttempts)?value.outageTypeAttempts:{}).filter(([id,t])=>value.profiles.some(p=>p.id===id)&&time(t)&&t<=now)),
    at:!invalidWeather&&time(value.at)&&value.at<=now?value.at:0,day:validDate(value.day)?value.day:'',
    retryAt:time(value.retryAt)&&value.retryAt<=now+300000?value.retryAt:0,
    subscriptionAt:time(value.subscriptionAt)&&value.subscriptionAt<=now?value.subscriptionAt:0,
    invalidations:object(value.invalidations)?value.invalidations:{},retryInvalidations:object(value.retryInvalidations)?value.retryInvalidations:{}};
}
