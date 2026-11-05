"use strict";
// GEO-03: the user chooses a settlement only; all administrative/source routing is background.
window.SvitloGeography = (() => {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const code=/^UA[0-9]{17}$/,uuid=/^[a-f0-9-]{36}$/i;
 const fresh=()=>({version:2,stage:'settlement',query:'',region:null,community:null,settlement:null,routes:[]});
 function restore(value){
  if(!value||JSON.stringify(value).length>24000||![1,2].includes(value.version)||typeof value.query!=='string'||value.query.length>120)return null;
  const v=JSON.parse(JSON.stringify(value));
  if(v.version===1){
   if(v.stage!=='done')return {...fresh(),query:v.stage==='settlement'?v.query:v.settlement?.name||''};
   v.version=2;v.routes=v.route?[{...v.route,cityId:null}]:[];
  }
  if(!['settlement','done'].includes(v.stage)||!Array.isArray(v.routes)||v.routes.length>16)return null;
  for(const k of ['region','community','settlement'])if(v[k]&&(!code.test(v[k].code)||typeof v[k].name!=='string'||v[k].name.length>240))return null;
  if(v.stage==='done'&&(!v.settlement||!v.region||v.settlement.region?.code!==v.region.code||!v.routes.length))return null;
  if(v.routes.some(r=>typeof r.routeId!=='string'||r.routeId.length>350||r.cityId!=null&&!uuid.test(r.cityId)))return null;
  if(v.community&&v.community.code!==v.settlement?.community?.code)return null;
  return v;
 }
 function create({get,render,remember,onCity,heading}){
  let serial=0,controller=null,timer=null,view={items:[],cursor:null,loading:false,error:null,selection:null};
  const current=()=>get()?.geography,active=()=>!!current()&&!get().city&&get().phase==='address';
  function cancel(){serial++;controller?.abort();controller=null;clearTimeout(timer);timer=null;view={items:[],cursor:null,loading:false,error:null,selection:null};}
  const context=x=>[x.type==='city'?'місто':x.type==='village'?'село':x.type==='settlement'?'селище':null,x.region?.name,x.district?.name,x.community?.name].filter(Boolean).join(' · ');
  function resultsHTML(){
   const g=current();if(!g)return '';
   if(view.error)return '<p class="onboard-support" role="status">Не вдалося завантажити дані. Спробуйте ще раз.</p><button class="action" data-action="geo-retry">Спробувати ще</button>';
   let html=view.items.map(x=>`<button class="onboard-result geo-result" aria-label="${esc(x.name+', '+context(x))}" data-action="geo-select" data-key="${esc(x.code)}"><strong>${esc(x.name)}</strong><small>${esc(context(x))}</small></button>`).join('');
   if(!view.items.length&&!view.loading)html+=`<p class="onboard-support" role="status">${g.query.trim().length<2?'Введіть назву міста або села.':'За цим запитом нічого не знайдено. Перевірте назву.'}</p>`;
   if(view.loading)html+='<p class="onboard-support" role="status" aria-live="polite">Завантажую…</p>';
   if(view.cursor)html+=`<button class="action geo-more" data-action="geo-more" ${view.loading?'disabled':''}>Показати ще</button>`;
   return html;
  }
  function paint(){const node=document.getElementById('geo-results');if(node){node.innerHTML=resultsHTML();node.setAttribute('aria-busy',String(view.loading));}}
  async function load(more=false){
   if(!active())return;const flow=get(),g=current(),cursor=more?view.cursor:null;if(more&&!cursor)return;
   controller?.abort();controller=new AbortController();const seq=++serial;view={items:more?view.items:[],cursor:null,loading:g.query.trim().length>=2,error:null,selection:null};paint();
   if(g.query.trim().length<2)return;
   try{
    const response=await window.SvitloLive.geography('settlements',{kind:'settlements',availableOnly:true,q:g.query,limit:50,...(cursor?{cursor}:{})},controller.signal);
    if(get()!==flow||current()!==g||seq!==serial)return;if(!Array.isArray(response.items))throw Error('invalid settlement response');
    view={items:more?[...new Map([...view.items,...response.items].map(x=>[x.code,x])).values()]:response.items,cursor:response.nextCursor||null,loading:false,error:null,selection:null};paint();remember();
   }catch(e){if(get()!==flow||current()!==g||seq!==serial||e.name==='AbortError')return;view={items:[],cursor:null,loading:false,error:true,selection:null};paint();}
  }
  function start(){cancel();if(active()){render(false);queueMicrotask(()=>load());}}
  function html(){const g=current();return `<section class="onboard-address-flow geo-address-flow" aria-label="Місто або село">${heading?heading():'<h1>Оберіть місто або село</h1>'}<div class="card outlined onboard-card"><label class="onboard-label" for="geo-query">Місто або село</label><input id="geo-query" class="field" type="search" data-geo-query maxlength="120" autocomplete="off" spellcheck="false" value="${esc(g.query)}" placeholder="Введіть назву"><div id="geo-results" class="onboard-results geo-results" aria-busy="${view.loading}">${resultsHTML()}</div>${!get().initial?'<button class="action geo-secondary" data-action="onboard-cancel">Скасувати додавання</button>':''}</div></section>`;}
  async function selectRecord(record){
   if(!active())return;const flow=get(),g=current();controller?.abort();controller=new AbortController();const signal=controller.signal,seq=++serial;view.loading=true;view.error=null;view.selection=record;paint();
   try{
    const response=await window.SvitloLive.geography('settlement-routes',{settlementCode:record.code},signal);
    if(!Array.isArray(response.routes)||!response.routes.length||response.routes.length>16)throw Error('temporarily unavailable');
    const routes=response.routes.map(r=>({...r,cityId:null}));let first=null,index=0;
    await Promise.all(Array.from({length:Math.min(2,routes.length)},async()=>{while(index<routes.length){const r=routes[index++];try{const result=await window.SvitloLive.geography('settlement-catalog',{settlementCode:record.code,routeId:r.routeId},signal);if(!uuid.test(result.city?.id))throw Error('invalid city');r.cityId=result.city.id;first||=result.city;}catch(e){if(signal.aborted)throw e;}}}));
    if(get()!==flow||current()!==g||seq!==serial)return;signal.throwIfAborted();if(!first)throw Error('temporarily unavailable');
    g.settlement=record;g.region=record.region||{code:record.code,name:record.name};g.community=record.community||null;g.routes=routes;g.stage='done';g.query='';cancel();
    onCity({...first,label:record.name,name:record.name,context:context(record)});
   }catch(e){if(get()!==flow||current()!==g||seq!==serial||e.name==='AbortError')return;view.loading=false;view.error=true;view.selection=record;paint();}
  }
  function handleAction(action,element){
   if(!action.startsWith('geo-'))return false;if(!active())return true;
   if(action==='geo-select'&&!view.loading){const r=view.items.find(x=>x.code===element.dataset.key);if(r)selectRecord(r);}
   else if(action==='geo-more')load(true);
   else if(action==='geo-retry')view.selection?selectRecord(view.selection):load();
   return true;
  }
  function handleInput(event){if(!active()||!event.target.hasAttribute('data-geo-query'))return false;const g=current();g.query=event.target.value.slice(0,120);controller?.abort();serial++;clearTimeout(timer);view={items:[],cursor:null,loading:g.query.trim().length>=2,error:null,selection:null};paint();remember();timer=setTimeout(()=>load(),250);return true;}
  return {active,html,start,cancel,handleAction,handleInput};
 }
 return {fresh,restore,create};
})();
