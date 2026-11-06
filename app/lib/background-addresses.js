// New-address lookup only. Canonical IDs always come from a route-scoped server response.
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x);
export const lookupName=x=>String(x??'').normalize('NFKC').toLocaleLowerCase('uk-UA').replace(/[’ʼ`]/g,"'").replace(/\s+/gu,' ').trim();
const keyOf=(x,kind)=>lookupName(x.label)+(kind==='street'&&x.districtVerified?'\0'+lookupName(x.district):'');
const problem=()=>Error('Тимчасово не вдалося перевірити адресу. Спробуйте ще раз.');
const aborted=signal=>signal?.throwIfAborted();
async function bounded(items,fn){let at=0;const result=new Array(items.length);await Promise.all(Array.from({length:Math.min(2,items.length)},async()=>{while(at<items.length){const i=at++;try{result[i]={ok:true,value:await fn(items[i])};}catch(error){result[i]={ok:false,error};}}}));return result;}
export function createBackgroundAddresses(request,{now=Date.now,newToken=()=>crypto.randomUUID()}={}){
 const cursors=new Map(),streetCache=new Map();
 const scope=(flow,kind,q)=>JSON.stringify([flow.geography.settlement.code,flow.geography.routes.map(r=>r.routeId),kind,kind==='houses'?flow.street.id:null,lookupName(q)]);
 async function city(g,r,signal){if(!uuid(r.cityId)){const result=await request('settlement-catalog',{settlementCode:g.settlement.code,routeId:r.routeId},signal);if(!uuid(result.city?.id))throw problem();r.cityId=result.city.id;}return r.cityId;}
 async function streetRefs(flow,signal){
  const g=flow.geography,s=flow.street,known=Array.isArray(s.alternatives)?s.alternatives:[],cacheKey=JSON.stringify([g.settlement.code,g.routes.map(r=>r.routeId),s.id,keyOf({...s,label:s.label||s.name},'street')]),saved=streetCache.get(cacheKey);
  if(saved&&saved.until>now())return saved.value;
  const responses=await bounded(g.routes,async r=>{const cityId=await city(g,r,signal),refs=[];let cursor=null,pages=0;const seen=new Set();do{aborted(signal);const page=await request('settlement-search',{settlementCode:g.settlement.code,routeId:r.routeId,kind:'streets',parentId:cityId,q:s.label||s.name,limit:50,...(cursor?{cursor}:{})},signal);if(!Array.isArray(page.items))throw problem();for(const x of page.items)if(uuid(x.id)&&keyOf(x,'street')===keyOf({...s,label:s.label||s.name},'street'))refs.push({routeId:r.routeId,parentId:x.id,cityId});cursor=page.nextCursor||null;if(cursor&&seen.has(cursor)||++pages>100)throw problem();if(cursor)seen.add(cursor);}while(cursor);return refs;});
  aborted(signal);const partial=responses.some(r=>!r.ok),refs=responses.filter(r=>r.ok).flatMap(r=>r.value);
  for(const x of known)if(uuid(x.id)&&g.routes.some(r=>r.routeId===x.routeId)&&!refs.some(r=>r.routeId===x.routeId&&r.parentId===x.id))refs.push({routeId:x.routeId,parentId:x.id,cityId:x.cityId});
  if(!known.length&&g.routes.length===1&&uuid(s.id)&&!refs.length)refs.push({routeId:g.routes[0].routeId,parentId:s.id,cityId:g.routes[0].cityId});
  const value={refs,partial};if(!partial){if(streetCache.size>=8)streetCache.delete(streetCache.keys().next().value);streetCache.set(cacheKey,{until:now()+60000,value});}return value;
 }
 async function search(kind,flow,q,signal,cursor=null){
  if(!['streets','houses'].includes(kind)||!flow.geography?.settlement||!Array.isArray(flow.geography.routes)||!flow.geography.routes.length||flow.geography.routes.length>16)throw problem();
  aborted(signal);const signature=scope(flow,kind,q),old=cursor?cursors.get(cursor):null;if(cursor&&(!old||old.signature!==signature||old.until<now()))throw problem();
  let state;
  if(old){state=structuredClone(old);for(const s of state.streams)s.failed=false;}
  else{const g=flow.geography;let refs,partial=false;if(kind==='houses')({refs,partial}=await streetRefs(flow,signal));else refs=g.routes.map(r=>({routeId:r.routeId,parentId:r.cityId,cityId:r.cityId}));state={signature,until:now()+300000,partial,streams:refs.map(r=>({...r,items:[],next:null,done:false,failed:false,pages:0,seen:[]}))};}
  const g=flow.geography;
  async function head(s){if(s.done||s.failed||s.items.length)return;try{if(!s.parentId){const route=g.routes.find(r=>r.routeId===s.routeId);s.parentId=await city(g,route,signal);s.cityId=s.parentId;}
   do{aborted(signal);const page=await request('settlement-search',{settlementCode:g.settlement.code,routeId:s.routeId,kind,parentId:s.parentId,q:q.slice(0,120),limit:50,...(s.next?{cursor:s.next}:{})},signal);if(!Array.isArray(page.items)||page.items.length>50||page.items.some(x=>!uuid(x.id)||typeof x.label!=='string'))throw problem();
    const next=page.nextCursor||null;if(next&&s.seen.includes(next)||++s.pages>100)throw problem();if(next)s.seen.push(next);s.items=page.items.map(x=>({...x,routeId:s.routeId,cityId:s.cityId}));s.next=next;s.done=!next;s.failed=false;
   }while(!s.items.length&&!s.done);
  }catch(e){aborted(signal);s.failed=true;}}
  const output=[];
  while(output.length<50){await bounded(state.streams,head);aborted(signal);const heads=state.streams.filter(s=>s.items.length);if(!heads.length)break;const key=heads.map(s=>keyOf(s.items[0],kind==='streets'?'street':'house')).sort()[0],members=[];
   for(const s of state.streams){while(s.items.length&&keyOf(s.items[0],kind==='streets'?'street':'house')===key){members.push(s.items.shift());if(!s.items.length&&!s.done)await head(s);}}
   const unique=[...new Map(members.map(x=>[x.id,x])).values()];if(!unique.length)throw problem();output.push({...unique[0],alternatives:unique.map(x=>({id:x.id,routeId:x.routeId,cityId:x.cityId})),lookupPartial:state.partial||state.streams.some(s=>s.failed)});
  }
  if(!output.length&&(state.partial||state.streams.some(s=>s.failed)))throw problem();aborted(signal);if(cursor)cursors.delete(cursor);let nextCursor=null;
  if(state.partial||state.streams.some(s=>s.items.length||!s.done||s.failed)){nextCursor=newToken();if(cursors.size>=8)cursors.delete(cursors.keys().next().value);state.until=now()+300000;cursors.set(nextCursor,state);}return {items:output,nextCursor};
 }
 async function resolve(flow,signal){
  const ids=[...new Set((flow.house.alternatives||[{id:flow.house.id}]).map(x=>x.id))];if(!ids.length||ids.length>32||ids.some(id=>!uuid(id)))throw problem();
  const values=await bounded(ids,addressId=>request('resolve',{addressId},signal));aborted(signal);const results=values.filter(x=>x.ok).map(x=>x.value).filter(x=>!['disabled','unsupported'].includes(x.operator?.supportState));if(!results.length)throw problem();
  if(flow.lineId){const chosen=results.filter(x=>x.resolution?.lines?.some(l=>l.id===flow.lineId));if(chosen.length!==1)throw problem();return {resolved:await request('resolve',{addressId:chosen[0].address.id,lineId:flow.lineId},signal)};}
  const confirmed=results.filter(x=>x.resolution?.complete&&['resolved','excluded'].includes(x.resolution.state)&&x.resolution.lines?.length),candidates=confirmed.length?confirmed:results,groups=new Map();
  for(const r of candidates)for(const line of r.resolution?.lines||[]){const key=JSON.stringify([r.operator?.id,r.resolution.state,line.groupCode??null,line.groupCode?null:line.key??line.id]);if(!groups.has(key))groups.set(key,{...line,label:line.label+(line.groupCode?' · черга '+line.groupCode:''),addressId:r.address.id});}
  if(flow.continueWithoutQueue){const selected=results.find(r=>r.address.id===flow.house.id);if(!selected||values.some(x=>!x.ok)||results.some(r=>r.resolution?.provenance?.sourceUnavailable))throw problem();return {resolved:selected,unresolved:true};}
  if(candidates.length===1){const r=candidates[0];if(r.resolution?.lines?.length>1&&!r.selection?.lineId&&!r.resolution.complete)return {requiresLine:true,lines:[...groups.values()]};return {resolved:r};}
  if(groups.size===1&&confirmed.length===candidates.length){const one=[...groups.values()][0];return {resolved:candidates.find(r=>r.address.id===one.addressId)};}
  if(groups.size)return {requiresLine:true,lines:[...groups.values()]};
  // Offer explicit continuation; do not silently choose a source identity or group.
  if(values.every(x=>x.ok)&&results.every(r=>!r.resolution?.provenance?.sourceUnavailable))return {requiresLine:true,lines:[]};
  throw problem();
 }
 return {search,resolve};
}
