// Publication, applicability and actual power are independent. Mirrors are not extra votes.
export const RECONCILIATION_VERSION='kyiv-sources-v2';
const stamp=x=>Number.isFinite(x)&&x>0;
export function reconcileDay({date,primary,secondary=null,addressEmergency=false,hidden=false,now=Date.now()}){
 const evidence={policy:RECONCILIATION_VERSION,date,primarySource:'dtek-address',primaryPublishedAt:primary.publishedAt??null,primaryCheckedAt:primary.checkedAt,
  secondarySource:'yasno-official',secondaryPublishedAt:secondary?.publishedAt??null,secondaryCheckedAt:secondary?.checkedAt??null,secondaryStatus:secondary?.status??null,powerState:'unknown',
  publicationAgeWarning:stamp(primary.publishedAt)&&primary.publishedAt<now-172800000};
 const decision=(state,reason,intervals=primary.intervals||[],extra={})=>({state,reason,intervals,evidence:{...evidence,...extra,reason}});
 if(addressEmergency)return decision('suspended','address_emergency',[],{scope:'address_line',publishedIntervals:primary.intervals||[]});
 if(hidden)return decision('suspended','primary_hides_daily_schedule',[],{scope:'primary_publication',publishedIntervals:primary.intervals||[]});
 if(primary.state==='not_published')return decision('not_published','no_primary_schedule_for_date',[]);
 if(!stamp(primary.publishedAt)||!stamp(primary.checkedAt)||primary.publishedAt>now+300000||primary.checkedAt>now+300000)return decision('unknown','invalid_primary_clock',[]);
 if(primary.checkedAt+120000<=now)return decision('stale','primary_fetch_expired');
 if(primary.state!=='published')return decision('unknown',primary.reason||'incomplete_primary_schedule');
 const fresh=secondary&&secondary.checkedAt+120000>now&&secondary.checkedAt<=now+300000;
 if(!fresh)return decision('unknown',secondary?'secondary_fetch_expired':'secondary_unavailable',primary.intervals,{publication:'published',applicability:'unconfirmed'});
 if(secondary.date!==date)return decision('unknown','secondary_does_not_cover_date',primary.intervals,{publication:'published',applicability:'unconfirmed'});
 if(!stamp(secondary.publishedAt)||secondary.publishedAt>now+300000)return decision('unknown','invalid_secondary_clock');
 if(secondary.status==='ScheduleApplies')return decision('published','sources_support_schedule',primary.intervals,{publication:'published',applicability:'reported'});
 if(secondary.status==='EmergencyShutdowns'){
  if(secondary.publishedAt>=primary.publishedAt)return decision('suspended','emergency_report_newer_than_plan',[],{scope:'reported_group_day',publication:'published',applicability:'suspended',publishedIntervals:primary.intervals});
  // Publishing a new plan alone is not proof that an emergency was cancelled.
  return decision('unknown','newer_plan_conflicts_with_emergency',primary.intervals,{publication:'published',applicability:'conflict'});
 }
 if(secondary.status==='WaitingForSchedule'&&primary.publishedAt>secondary.publishedAt+300000)return decision('published','primary_published_after_waiting',primary.intervals,{publication:'published',applicability:'reported'});
 if(secondary.status==='NoOutages'&&!primary.intervals.length)return decision('published','sources_report_no_planned_intervals',[],{publication:'published',applicability:'reported'});
 return decision('unknown','official_sources_disagree',primary.intervals,{publication:'published',applicability:'conflict'});
}
