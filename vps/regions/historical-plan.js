import {civil,addDays} from '../../app/lib/time.js';

export const HISTORICAL_PLAN_VERSION='archived-official-plan-v2';
// This records the history of a published plan, never measured power. Only
// adjacent agreeing observations of the same plan bound a verified period.
export function historicalPlan(rows,date,now=Date.now()){
 const from=civil(date),until=Math.min(civil(addDays(date,1)),now),periods=[];
 if(!Array.isArray(rows)||rows.length>400||until<=from)return null;
 const valid=row=>{
  if(!row||row.state!=='published'||row.classification!=='agreement'||row.applicability!=='reported'||row.intervalComparison!=='equal'||
   !Number.isFinite(row.observedAt)||row.observedAt>now||!Number.isFinite(row.primaryCheckedAt)||!Number.isFinite(row.secondaryCheckedAt)||
   row.primaryCheckedAt<0||row.secondaryCheckedAt<0||row.primaryCheckedAt>row.observedAt||row.secondaryCheckedAt>row.observedAt||Math.abs(row.primaryCheckedAt-row.secondaryCheckedAt)>30000||!Array.isArray(row.intervals)||row.intervals.length>96)return null;
  if(row.intervals.some(e=>!e||!Number.isFinite(e.start)||!Number.isFinite(e.end)||e.start<from||e.end>civil(addDays(date,1))||e.end<=e.start))return null;
  const intervals=row.intervals.map(e=>({start:e.start,end:e.end})).sort((a,b)=>a.start-b.start);
  if(intervals.some((e,i)=>i&&e.start<intervals[i-1].end))return null;
  return {at:Math.min(row.observedAt,row.primaryCheckedAt,row.secondaryCheckedAt),intervals};
 };
 let prior=null;
 for(const row of rows){
  const next=valid(row);
  if(next&&prior&&next.at>prior.at&&next.at-prior.at<=360000&&JSON.stringify(next.intervals)===JSON.stringify(prior.intervals)){
   const start=Math.max(from,prior.at),end=Math.min(until,next.at),last=periods.at(-1);
   if(end>start){if(last&&last.end===start&&JSON.stringify(last.intervals)===JSON.stringify(next.intervals))last.end=end;
    else periods.push({start,end,intervals:next.intervals});}
  }
  prior=next;
 }
 return periods.length?{version:1,basis:'archived_official_plan',periods}:null;
}
