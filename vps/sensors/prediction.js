import {addDays,civil,dayKey} from '../../app/lib/time.js';
// An estimate of recurring wall-clock behaviour, never measured/official evidence.
// Each day votes once per 15-minute bin; missing coverage cannot vote.
export function predictDays(days,today){
 const slots=Array.from({length:96},()=>({on:0,off:0}));let usable=0;
 for(const day of days){
  if(day.date>=today||day.observation?.semantics!=='explicit_coverage_only'||!day.observation.complete)continue;
  const start=Date.parse(day.dayStartUtc),end=Date.parse(day.dayEndUtc);
  if(end-start!==86400000)continue; // DST transition days do not vote in a 24h template.
  const known=day.observation.intervals||[];
  const covered=known.reduce((n,r)=>n+Math.max(0,Date.parse(r.end)-Date.parse(r.start)),0);
  if(covered<(end-start)*.8)continue;
  usable++;
  for(let i=0;i<96;i++){
   const a=civil(day.date,i*15),b=civil(day.date,(i+1)*15),votes={on:0,off:0};
   for(const r of known)if(['on','off'].includes(r.powerState))votes[r.powerState]+=Math.max(0,Math.min(b,Date.parse(r.end))-Math.max(a,Date.parse(r.start)));
   if(votes.on>=900000&&votes.off===0)slots[i].on++;else if(votes.off>=900000&&votes.on===0)slots[i].off++;
  }
 }
 if(usable<7)return {};
 const states=slots.map(s=>{const total=s.on+s.off;if(total<7)return 'unknown';return Math.max(s.on,s.off)/total>=.85?(s.on>s.off?'on':'off'):'unknown';});
 if(states.filter(s=>s!=='unknown').length<77)return {};
 return Object.fromEntries([today,addDays(today,1)].map(date=>{
  const from=civil(date),length=(civil(addDays(date,1))-from)/60000,segments=[];
  for(let at=from;at<civil(addDays(date,1));at+=900000){
   const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
   const hour=Number(parts.find(p=>p.type==='hour').value),minute=Number(parts.find(p=>p.type==='minute').value),state=states[hour*4+Math.floor(minute/15)];
   const start=(at-from)/60000,end=Math.min(start+15,length),last=segments.at(-1);
   if(last?.state===state)last.end=end;else segments.push({start,end,state});
  }
  return [date,{available:true,segments,dayLength:length,method:'recurring_observations_v1',sampleDays:usable,reason:null}];
 }));
}
export async function phoneForecast(phone,input,now=Date.now()){
 const today=dayKey(now);if(input.date<today||input.date>addDays(today,1))return {};
 const days=[]; // Bounded and sequential within the existing authenticated transaction.
 for(let n=1;n<=14;n++)days.push(await phone.history({...input,action:'history',date:addDays(today,-n)}));
 return predictDays(days,today);
}
