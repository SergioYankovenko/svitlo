import { reminderTitle, notificationBody } from "../app/lib/notifications.js";
import {countdown} from '../app/lib/schedule.js';
import {dayKey} from '../app/lib/time.js';
import {retryDelay} from './provider-transport.js';

export function reminderWork(p,now,timer=countdown(p.snapshot,now)) {
  const prefs=p.preferences||{},lead=[5,15,30,60].includes(+prefs.lead)?+prefs.lead:30;
  let next=now+300000,event=null;
  if(Number.isFinite(timer.target)&&timer.target>now&&timer.minutes!==undefined) {
    const restore=timer.label==='До відновлення',channel=restore?'restoration':'reminder';
    next=timer.target-lead*60000;
    if(next<=now || prefs[channel]===false)next=timer.target+1000;
    if(prefs[channel]!==false&&timer.minutes>0&&timer.minutes<=lead)event={
      event_key:`reminder:${restore}:${timer.target}`,channel,
      title:reminderTitle(restore,timer.target),
      body:notificationBody(p),date:dayKey(now),expires_at:timer.target,
    };
  }
  // Unknown/stale data is checked again; it is never turned into a promise of power.
  return {id:p.id,token:p.token,generation:p.generation,next_due:Math.max(now+1000,next),event};
}

export async function runScaledJobs(service) {
  const {db}=service,claim=await db.jobsClaim();
  if(!claim.granted)return {status:'busy',refreshed:0,sent:0};
  const deadline=service.now()+service.jobBudgetMs;
  const stats={refreshed:0,sent:0,failedRefreshes:0,partialRefreshes:0,failedDeliveries:0,expiredSubscriptions:0,skippedRefreshes:0,remindersChecked:0};
  try {
    let feedResult=null;
    if(db.scheduledMaintenance) {
      const work=await db.jobsWork(service.now());
      if(work.feed)feedResult=(async()=>{
        stats.feedChecks=1;
        try {
          const value=await service.source.feed(service.now(),await db.feed(),{force:true,signal:AbortSignal.timeout(Math.max(1,deadline-service.now()-2000))});
          if(!service.source.sharedFeed)await db.saveFeed(value);
          if(value.partial)stats.failedFeeds=1;
          return {value};
        }catch(error){stats.failedFeeds=1;return {error};}
      })();
    }
    const refresh=async()=>{
      const end=deadline-3000;let count=0;
      const worker=async()=>{
        while(count<60&&service.now()+2500<end) {
          count++;const [p]=await db.due(service.now(),1);if(!p)break;
          if(service.now()+2000>=end){await db.releaseProfile(p);break;}
          try {
            const result=await service.refresh(p,null,{signal:AbortSignal.timeout(Math.max(1,end-service.now()-1000)),feedResult});
            stats.refreshed++;if(result.snapshot?.failures?.length||result.snapshot?.feedFailed)stats.partialRefreshes++;
          } catch(e) {
            if(e.status===404)stats.skippedRefreshes++;else stats.failedRefreshes++;
            await db.releaseProfile(p).catch(()=>{});break;
          }
        }
      };
      await Promise.all(Array.from({length:4},worker));
    };
    const notify=async()=>{
      // Indexed tasks, not a cursor over every saved profile. CPU work is bounded.
      const memo=new Map();
      for(let page=0;page<3&&service.now()+15000<deadline;page++) {
      const batch=await db.reminderClaim(service.now(),300);
      const items=batch.map(p=>{
        const key=JSON.stringify(p.snapshot);let timer=memo.get(key);
        if(!timer){timer=countdown(p.snapshot,service.now());memo.set(key,timer);}
        return reminderWork(p,service.now(),timer);
      });
      if(items.length)stats.remindersChecked+=await db.reminderFinish(items);
      if(batch.length<300)break;
      }
      let claimed=0;
      while(claimed<600&&service.now()+11000<deadline) {
        const batch=await db.deliveryBatch(service.now(),Math.min(16,600-claimed));if(!batch.length)break;
        claimed+=batch.length;const finished=[];
        for(let i=0;i<batch.length;i+=4) {
          const wave=batch.slice(i,i+4);
          if(service.now()+11000>=deadline) {
            finished.push(...batch.slice(i).map(x=>({id:x.id,token:x.lease_token,delivered:null,retry_at:service.now()})));break;
          }
          const valid=new Set(await db.deliveryActive(wave,service.now()));
          await Promise.all(wave.map(async item=>{
            const result={id:item.id,token:item.lease_token,delivered:null,retry_at:service.now()};finished.push(result);
            const remaining=item.expires_at-service.now();
            if(!valid.has(item.id)||remaining<1000)return;
            try {
              await service.push(item.subscription,{title:item.title,body:item.body,tag:item.event_key,date:item.date,profile:item.profile_id},
                {ttl:Math.max(1,Math.min(3600,Math.floor(remaining/1000)))});
              result.delivered=true;result.retry_at=0;stats.sent++;
            } catch(e) {
              if([404,410].includes(e.statusCode)) {
                await db.removeSubscription(item.subscription_id);stats.expiredSubscriptions++;
              } else {
                result.delivered=false;
                result.retry_at=service.now()+Math.max(Math.min(300000,30000*2**Math.min(item.attempts||1,4)),retryDelay(e.headers?.['retry-after'],service.now()));
                stats.failedDeliveries++;
              }
            }
          }));
        }
        await db.deliveryFinishBatch(finished);
      }
    };
    // Wait for both phases even if one fails; never release the global lease while a phase is active.
    const results=await Promise.allSettled([refresh(),notify(),feedResult]);
    for(const r of results)if(r.status==='rejected')throw r.reason;
    if(!db.scheduledMaintenance)await db.cleanup(service.now());
    return {...stats,budgetExhausted:service.now()+11000>=deadline};
  } finally {await db.jobsFinish(claim.token,null);}
}
