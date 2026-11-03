import {createHash} from 'node:crypto';import {problem} from '../telemetry/validation.js';
export const historyLimits={historyDays:7,maxDayEvents:5000,maxCoverageSeconds:180,maxStoredEvents:19999};
const iso=t=>new Date(t).toISOString();const fail=()=>{throw problem(503,'sensor_history_unavailable');};
const time=value=>{const t=typeof value==='string'?Date.parse(value):NaN;if(!Number.isFinite(t))fail();return t;};
function append(list,item){const p=list.at(-1);if(p&&p.end===item.start&&p.powerState===item.powerState&&JSON.stringify(p.streamIds)===JSON.stringify(item.streamIds)&&p.reason===item.reason)p.end=item.end;else list.push(item);}
export function buildDayOverview(source){
 if(!source||source.timezone!=='Europe/Kyiv'||!/^\d{4}-\d\d-\d\d$/.test(source.date)||!source.sensor||!source.signal||!Array.isArray(source.events)||typeof source.complete!=='boolean'||source.events.length>5000)fail();
 const start=time(source.dayStartUtc),end=time(source.dayEndUtc),asOf=time(source.asOf),bound=time(source.bindingStartedAt),through=Math.min(end,Math.max(start,asOf));
 if(end<=start||end-start>26*3600000||source.signal.sensorId!==source.sensor.sensorId||source.signal.bindingEpoch!==source.sensor.bindingEpoch||source.signal.measurementPointId!==source.sensor.measurementPointId)fail();
 const edges=new Map(),points=[],issues=[];function edge(t,state,stream,delta){const xs=edges.get(t)||[];xs.push({state,stream,delta});edges.set(t,xs);}
 for(const e of source.events){
  const received=time(e.receivedAt),at=e.observedAt===null?null:time(e.observedAt);
  if(received>asOf||!['sample','heartbeat'].includes(e.eventType)||!['synchronized','unsynchronized'].includes(e.clockQuality)||!Number.isSafeInteger(e.sequence)||e.sequence<1||!['on','off',null].includes(e.powerState)||![1,2].includes(e.protocolVersion)||e.eventType==='heartbeat'&&e.powerState!==null||e.eventType==='sample'&&!['on','off'].includes(e.powerState)||e.clockQuality==='synchronized'&&at===null||e.clockQuality==='unsynchronized'&&at!==null)fail();
  const trusted=e.eventType==='sample'&&e.clockQuality==='synchronized'&&at!==null&&['on','off'].includes(e.powerState);
  if(trusted&&at>=start&&at<end&&at<=asOf&&at>=bound)points.push({eventId:e.eventId,streamId:e.streamId,sequence:e.sequence,at:iso(at),receivedAt:iso(received),powerState:e.powerState,evidence:'point'});
  if(e.sequenceGap)issues.push({eventId:e.eventId,type:'sequence_gap',at:iso(at??received)});
  if(e.eventType==='sample'&&!trusted)issues.push({eventId:e.eventId,type:'clock_untrusted',at:iso(received)});
  if(['ignored_late','ignored_out_of_order','accepted_late'].includes(e.outcome))issues.push({eventId:e.eventId,type:'delayed_or_out_of_order',at:iso(at??received)});
  if((e.coverageStart===null)!==(e.coverageEnd===null))fail();
  if(e.coverageStart!==null){
   const a=time(e.coverageStart),b=time(e.coverageEnd);if(!trusted||e.protocolVersion!==2||a>=b||b!==at||a<bound||b>received||b-a>180000)fail();
   const lo=Math.max(start,a),hi=Math.min(through,b);if(lo<hi){edge(lo,e.powerState,e.streamId,1);edge(hi,e.powerState,e.streamId,-1);}
  }
 }
 const intervals=[],gaps=[];edges.set(start,edges.get(start)||[]);edges.set(through,edges.get(through)||[]);
 if(bound>start&&bound<through)edges.set(bound,edges.get(bound)||[]);
 const active=new Map(),stamps=[...edges.keys()].filter(t=>t>=start&&t<=through).sort((a,b)=>a-b);
 for(let i=0;i<stamps.length-1;i++){
  const a=stamps[i],b=stamps[i+1];for(const x of edges.get(a)){const k=x.state+'|'+x.stream;active.set(k,(active.get(k)||0)+x.delta);if(active.get(k)===0)active.delete(k);}
  const states=new Set([...active.keys()].map(k=>k.slice(0,k.indexOf('|'))));
  if(states.size===1){const state=[...states][0],streams=[...active.keys()].map(k=>k.slice(k.indexOf('|')+1)).sort();append(intervals,{start:iso(a),end:iso(b),powerState:state,streamIds:[...new Set(streams)],evidence:'declared_coverage'});}
  else append(gaps,{start:iso(a),end:iso(b),reason:states.size>1?'conflicting_evidence':a<bound?'before_binding':'no_coverage'});
 }
 points.sort((a,b)=>a.at.localeCompare(b.at)||a.streamId.localeCompare(b.streamId)||a.sequence-b.sequence);
 const duration=x=>Date.parse(x.end)-Date.parse(x.start),on=intervals.filter(x=>x.powerState==='on').reduce((n,x)=>n+duration(x),0),off=intervals.filter(x=>x.powerState==='off').reduce((n,x)=>n+duration(x),0),known=on+off,elapsed=through-start;
 const future=asOf<start,limited=!source.complete;const availability=limited||!known?'unavailable':known===elapsed?'available':'partial';
 const reason=limited?'capacity_limited':future?'future_day':!known?(end<=bound?'before_binding':points.length?'point_only':'no_declared_coverage'):null;
 const observation={availability,reason,complete:source.complete,points:limited?[]:points,intervals:limited?[]:intervals,
  coverageBounds:limited?[]:intervals.map(({start,end})=>({start,end})),gaps:limited?[]:gaps,issues:limited?[]:issues,through:future?null:iso(through),
  summary:{onMs:limited||!known?null:on,offMs:limited||!known?null:off,knownMs:limited?null:known,unknownMs:limited?null:elapsed-known,elapsedMs:elapsed,futureMs:end-through},
  semantics:'explicit_coverage_only'};
 const revision=createHash('sha256').update(JSON.stringify([source.sensor.sensorId,source.sensor.bindingEpoch,source.date,source.complete,source.events])).digest('hex');
 return {overviewVersion:1,sensorId:source.sensor.sensorId,bindingEpoch:source.sensor.bindingEpoch,measurementPointId:source.sensor.measurementPointId,canonicalAddressId:source.sensor.canonicalAddressId,lineId:source.sensor.lineId,
  date:source.date,timezone:source.timezone,dayStartUtc:iso(start),dayEndUtc:iso(end),dayLengthMinutes:(end-start)/60000,asOf:iso(asOf),revision,horizon:source.horizon,
  signal:{...source.signal,scope:'current_binding'},observation,prediction:{availability:'unavailable',reason:'not_implemented',intervals:[]},
  capabilities:{history:true,overview:true,prediction:false,testOnly:true,limits:historyLimits}};
}
