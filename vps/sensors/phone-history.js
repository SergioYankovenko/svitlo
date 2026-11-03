import {createHash} from 'node:crypto';
// Exact evidence projection. No point interpolation, rounding, schedule or forecast.
export function phoneDay(source){
 const start=Date.parse(source.dayStartUtc),end=Date.parse(source.dayEndUtc),now=Date.parse(source.asOf),through=Math.max(start,Math.min(end,now));
 const edges=new Map([[start,[]],[through,[]]]),intervals=[],gaps=[];
 const edge=(at,state,delta)=>{const xs=edges.get(at)||[];xs.push({state,delta});edges.set(at,xs);};
 for(const r of source.ranges){const a=Math.max(start,Date.parse(r.start)),b=Math.min(through,Date.parse(r.end));if(a<b){edge(a,r.powerState,1);edge(b,r.powerState,-1);}}
 const active={on:0,off:0},times=[...edges.keys()].sort((a,b)=>a-b);
 const append=(xs,a,b,extra)=>{const item={start:new Date(a).toISOString(),end:new Date(b).toISOString(),...extra},prev=xs.at(-1);if(prev&&prev.end===item.start&&prev.powerState===item.powerState&&prev.reason===item.reason)prev.end=item.end;else xs.push(item);};
 for(let i=0;i<times.length-1;i++){const a=times[i],b=times[i+1];for(const x of edges.get(a))active[x.state]+=x.delta;if(b<=a)continue;
  if(!source.complete)append(gaps,a,b,{reason:'capacity_limited'});else if(active.on>0&&active.off>0)append(gaps,a,b,{reason:'conflicting_evidence'});else if(active.on>0||active.off>0)append(intervals,a,b,{powerState:active.on>0?'on':'off'});else append(gaps,a,b,{reason:'no_coverage'});}
 const sum=state=>intervals.filter(x=>x.powerState===state).reduce((n,x)=>n+Date.parse(x.end)-Date.parse(x.start),0),onMs=sum('on'),offMs=sum('off'),knownMs=onMs+offMs;
 const {ranges,complete,...base}=source;return {...base,overviewVersion:1,revision:createHash('sha256').update(JSON.stringify([source.sensorId,source.bindingEpoch,source.date,complete,ranges])).digest('hex'),capabilities:{history:true,overview:true,prediction:false,testOnly:true,limits:{historyDays:90,maxDayRanges:2000}},dayLengthMinutes:(end-start)/60000,
  observation:{availability:knownMs===0?'unavailable':knownMs===through-start?'available':'partial',reason:now<start?'future_day':!complete?'capacity_limited':knownMs===0?'no_coverage':null,complete,points:[],issues:[],through:now<start?null:new Date(through).toISOString(),intervals,gaps,coverageBounds:intervals.map(({start,end})=>({start,end})),summary:{onMs:knownMs?onMs:null,offMs:knownMs?offMs:null,knownMs:complete?knownMs:null,unknownMs:complete?through-start-knownMs:null,elapsedMs:through-start,futureMs:end-through},semantics:'explicit_coverage_only'},prediction:{availability:'unavailable',reason:'not_implemented',intervals:[]}};
}
