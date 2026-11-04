// QA-only calendar controls. Original public fixtures remain unmodified on disk.
// A single captured clock keeps current-day assertions stable across midnight.
import {addDays,civil,dayKey,parts} from '../../../app/lib/time.js';
const offset=(from,to)=>Math.round((Date.parse(to)-Date.parse(from))/86400000);
const stamp=at=>{const p=parts(at);return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;};
const midnight=date=>{
 const minutes=(Date.parse(date+'T00:00:00Z')-civil(date))/60000;
 return `${date}T00:00:00+${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
};
export function dtekFixtureAt(raw,now){
 const value=structuredClone(raw),date=dayKey(now),base=dayKey(Number(value.fact.today)*1000),delta=offset(base,date);
 value.fact.data=Object.fromEntries(Object.entries(value.fact.data).map(([key,groups])=>[String(civil(addDays(dayKey(Number(key)*1000),delta))/1000),groups]));
 value.fact.today=civil(date)/1000;value.fact.update=stamp(now-60000);value.synthetic=true;
 for(const records of Object.values(value.data))for(const row of Array.isArray(records)?records:[records])for(const field of ['start_date','end_date']){
  if(typeof row[field]==='string')row[field]=row[field].replace(/(\d{2}):(\d{2}) (\d{2})\.(\d{2})\.(\d{4})/g,(_m,h,m,d,month,y)=>{
   const shifted=addDays(`${y}-${month}-${d}`,delta);return `${h}:${m} ${shifted.slice(8)}.${shifted.slice(5,7)}.${shifted.slice(0,4)}`;
  });
 }
 return value;
}
export function yasnoFixtureAt(raw,now){
 const value=structuredClone(raw),date=dayKey(now);
 for(const group of Object.values(value)){
  const delta=offset(dayKey(Date.parse(group.today.date)),date);
  for(const key of ['today','tomorrow'])if(group[key]?.date)group[key].date=midnight(addDays(dayKey(Date.parse(group[key].date)),delta));
  group.updatedOn=new Date(now-1000).toISOString();
 }
 return value;
}
