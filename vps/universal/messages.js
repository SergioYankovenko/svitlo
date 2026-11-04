import {createHash} from 'node:crypto';
import {selectedLine} from '../../app/lib/universal-contract.js';
import {dayKey,addDays} from '../../app/lib/time.js';
import {dateLabel} from '../../app/lib/notifications.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32);
const signature=day=>(day?.intervals||[]).map(e=>[e.start,e.end]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
export function universalMessages(snapshot,old,now,history=[]){
 const s=snapshot.universal,line=selectedLine(s,snapshot.selectedLineId),before=selectedLine(old?.universal,old?.selectedLineId),messages=[];
 if(!line||s.supportState!=='available'||s.freshUntil<=now||!s.resolution.complete)return messages;
 const hourly=line.categories.hourly;
 if(hourly?.freshUntil>now)for(const day of hourly.days){
  if(day.state!=='published'||day.date<addDays(dayKey(now),-7)||day.date>addDays(dayKey(now),1))continue;
  const prior=before?.categories.hourly?.days.find(x=>x.date===day.date),previous=history.filter(m=>m.kind==='schedule'&&m.date===day.date&&m.addressId===s.addressId&&m.lineId===line.id).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
  const unchanged=prior?.state==='published'&&JSON.stringify(signature(prior))===JSON.stringify(signature(day));
  if(unchanged&&previous){messages.push(previous);continue;}
  const revisionType=prior?.state==='published'?'change':'publication';
  const id='universal:schedule:'+digest([s.addressId,line.id,day.date,signature(day),previous?.id||null]);
  messages.push({id,addressId:s.addressId,lineId:line.id,kind:'schedule',queue:snapshot.queue,date:day.date,revisionType,
   title:`Графік на ${dateLabel(day.date)}${revisionType==='change'?' оновлено':''}`,
   updatedAt:now,publishedAt:hourly.sourceUpdatedAt||s.sourceUpdatedAt||s.checkedAt,
   url:s.provenance.find(p=>typeof p.url==='string'&&p.url.startsWith('https://'))?.url||''});
 }
 const emergency=line.categories.emergency;
 const events=emergency?.days.filter(d=>d.state==='published').flatMap(d=>d.intervals).filter(e=>e.start<=now&&(e.end===null||e.end>now));
 if(emergency?.freshUntil>now&&events?.length)messages.push({id:'address:'+digest([s.addressId,line.id,events]),kind:'emergency',scope:'address',queue:snapshot.queue,date:dayKey(now),title:'Аварійні відключення за адресою',updatedAt:now});
 for(const notice of s.notices.filter(n=>n.kind==='regional_emergency'&&n.active))messages.push({
  id:'regional:'+digest([s.operatorId,notice.start,notice.sourceUpdatedAt]),kind:'emergency',scope:'region',date:dayKey(notice.start||now),
  title:'Аварійні відключення в області',updatedAt:notice.sourceUpdatedAt||s.checkedAt,url:notice.url||''});
 return messages;
}
