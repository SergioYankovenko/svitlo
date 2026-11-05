// Publication, applicability and actual power are independent. Mirrors are not extra votes.
export const RECONCILIATION_VERSION='kyiv-sources-v4';
const stamp=x=>Number.isFinite(x)&&x>0;
export function reconcileDay({date,primary,secondary=null,addressEmergency=false,hidden=false,now=Date.now()}){
 const secondaryIntervals=Array.isArray(secondary?.intervals)?secondary.intervals:[];
 const evidence={policy:RECONCILIATION_VERSION,date,primarySource:'dtek-address',primaryPublishedAt:primary.publishedAt??null,primaryCheckedAt:primary.checkedAt,
  secondarySource:'yasno-official',secondaryPublishedAt:secondary?.publishedAt??null,secondaryCheckedAt:secondary?.checkedAt??null,secondaryStatus:secondary?.status??null,powerState:'unknown',
  publicationAgeWarning:stamp(primary.publishedAt)&&primary.publishedAt<now-172800000};
 const decision=(state,reason,intervals=primary.intervals||[],extra={})=>({state,reason,intervals,evidence:{...evidence,...extra,reason}});
 if(!stamp(primary.checkedAt)||primary.checkedAt>now+300000)return decision('unknown','invalid_primary_clock',[]);
 if(primary.checkedAt+120000<=now)return decision('stale','primary_fetch_expired');
 if(addressEmergency)return decision('suspended','address_emergency',[],{scope:'address_line',publishedIntervals:primary.intervals||[]});
 if(hidden)return decision('suspended','primary_hides_daily_schedule',[],{scope:'primary_publication',publishedIntervals:primary.intervals||[]});
 const fresh=secondary&&stamp(secondary.checkedAt)&&secondary.checkedAt+120000>now&&secondary.checkedAt<=now+300000;
 const applicable=fresh&&secondary.date===date&&stamp(secondary.publishedAt)&&secondary.publishedAt<=now+300000;
 if(primary.state==='not_published'){
  if(applicable&&secondary.status==='EmergencyShutdowns')return decision('suspended','reported_emergency_without_primary_plan',[],{scope:'reported_group_day',publication:'not_published',applicability:'suspended',publishedIntervals:[]});
  if(applicable&&secondary.status==='ScheduleApplies')return decision('unknown','secondary_has_schedule_primary_missing',[],{publication:'not_published',applicability:'conflict',secondaryIntervals});
  return decision('not_published','no_primary_schedule_for_date',[]);
 }
 if(!stamp(primary.publishedAt)||primary.publishedAt>now+300000)return decision('unknown','invalid_primary_clock',[]);
 if(primary.state!=='published')return decision('unknown',primary.reason||'incomplete_primary_schedule');
 if(!fresh)return decision('unknown',secondary?'secondary_fetch_expired':'secondary_unavailable',primary.intervals,{publication:'published',applicability:'unconfirmed'});
 if(secondary.date!==date)return decision('unknown','secondary_does_not_cover_date',primary.intervals,{publication:'published',applicability:'unconfirmed'});
 if(!stamp(secondary.publishedAt)||secondary.publishedAt>now+300000)return decision('unknown','invalid_secondary_clock');
 if(secondary.status==='EmergencyShutdowns'){
  if(secondary.publishedAt>=primary.publishedAt)return decision('suspended','emergency_report_newer_than_plan',[],{scope:'reported_group_day',publication:'published',applicability:'suspended',publishedIntervals:primary.intervals});
  // Publishing a new plan alone is not proof that an emergency was cancelled.
  return decision('suspended','emergency_report_survives_new_plan',[],{scope:'reported_group_day',publication:'published',applicability:'suspended',publishedIntervals:primary.intervals});
 }
 if(secondary.status==='ScheduleApplies'||secondary.status==='NoOutages'){
  if(secondary.status==='NoOutages'&&secondaryIntervals.length)return decision('unknown','secondary_status_conflicts_with_slots',primary.intervals,{publication:'published',applicability:'conflict',secondaryIntervals});
  if(secondary.state!=='published')return decision('unknown','secondary_intervals_unavailable',primary.intervals,{publication:'published',applicability:'unconfirmed',secondaryReason:secondary.reason||'missing_complete_day'});
  const matches=primary.intervals.length===secondaryIntervals.length&&primary.intervals.every((e,i)=>e.start===secondaryIntervals[i].start&&e.end===secondaryIntervals[i].end);
  if(matches)return decision('published',secondary.status==='NoOutages'?'sources_report_no_planned_intervals':'sources_support_schedule',primary.intervals,{publication:'published',applicability:'reported',intervalComparison:'equal'});
  return decision('unknown','official_intervals_disagree',primary.intervals,{publication:'published',applicability:'conflict',intervalComparison:'different',secondaryIntervals,
   newerPublication:primary.publishedAt>secondary.publishedAt?'primary':primary.publishedAt<secondary.publishedAt?'secondary':'same_stamp'});
 }
 if(secondary.status==='WaitingForSchedule'&&primary.publishedAt>secondary.publishedAt+300000)return decision('published','primary_published_after_waiting',primary.intervals,{publication:'published',applicability:'reported',intervalComparison:'pending_secondary'});
 return decision('unknown','official_sources_disagree',primary.intervals,{publication:'published',applicability:'conflict'});
}
