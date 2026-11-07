import {createHash} from 'node:crypto';import {semanticPlan,nextPlanEvent,planWindows} from '../../app/lib/planning.js';
export const canonicalJson=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const planKey=(snapshot,lineId)=>createHash('sha256').update(canonicalJson(semanticPlan(snapshot,lineId))).digest('hex');
export class PlanningService {
 windows(snapshot,lineId,date,options){return planWindows(snapshot,lineId,date,options);}
 next(snapshot,lineId,options){return nextPlanEvent(snapshot,lineId,options);}
 key(snapshot,lineId){return planKey(snapshot,lineId);}
}
