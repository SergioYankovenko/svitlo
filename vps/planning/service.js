import {createHash} from 'node:crypto';import {semanticPlan,nextPlanEvent,planWindows} from '../../app/lib/planning.js';
export const planKey=(snapshot,lineId)=>createHash('sha256').update(JSON.stringify(semanticPlan(snapshot,lineId))).digest('hex');
export class PlanningService {
 windows(snapshot,lineId,date,options){return planWindows(snapshot,lineId,date,options);}
 next(snapshot,lineId,options){return nextPlanEvent(snapshot,lineId,options);}
 key(snapshot,lineId){return planKey(snapshot,lineId);}
}
