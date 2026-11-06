import {validUniversal} from './universal-contract.js';
import {addDays} from './time.js';
import {retainCurrentPlan} from './retained-plan.js';
// Retain published past dates within the SAME canonical address and stable line.
// Original publication timestamps stay intact: retention cannot renew freshness.
export function retainPublishedDays(next,prior,today,now=Date.now()){
  if(!validUniversal(next)||!validUniversal(prior)||next.addressId!==prior.addressId||next.operatorId!==prior.operatorId)return next;
  const retained=retainCurrentPlan(next,prior,now),cutoff=addDays(today,-6),copy=structuredClone(retained);let first=copy.coverage.fromDate,changed=retained!==next;
  for(const line of copy.lines){
    const old=prior.lines.find(l=>l.id===line.id&&l.groupCode===line.groupCode);if(!old)continue;
    for(const kind of line.supportedCategories){
      const category=line.categories[kind],before=old.categories[kind];if(!before)continue;
      for(const day of before.days){
        if(day.date<cutoff||day.date>=today)continue;
        const published=kind==='hourly'?(day.publication?.state==='published'||day.state==='published'):day.state==='published'||day.intervals.length;
        const existing=category.days.find(d=>d.date===day.date);
        if(!published||existing&&['published','excluded','suspended'].includes(existing.state))continue;
        if(existing)category.days=category.days.filter(d=>d!==existing);
        if(category.days.length>=14){const future=category.days.filter(d=>d.date>today).sort((a,b)=>b.date.localeCompare(a.date))[0];if(!future)continue;category.days=category.days.filter(d=>d!==future);}
        category.days.push(structuredClone(day));category.days.sort((a,b)=>a.date.localeCompare(b.date));first=day.date<first?day.date:first;changed=true;
      }
    }
  }
  if(!changed)return next;copy.coverage.fromDate=first;
  // A stable revision is assigned by the server seal; client cache uses a derived suffix.
  copy.revision=next.revision+':history';
  return validUniversal(copy)?copy:next;
}
