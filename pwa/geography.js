"use strict";
// GEO-02: transient new-address wizard only. Saved profile state is never read or rewritten here.
window.SvitloGeography = (() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stages=['region','community','settlement','route','done'],code=/^UA[0-9]{17}$/;
  const fresh=()=>({version:1,stage:'region',query:'',region:null,community:null,settlement:null,route:null});
  function restore(value){
    if(!value||JSON.stringify(value).length>14000||value.version!==1||!stages.includes(value.stage)||typeof value.query!=='string'||value.query.length>120)return null;
    const v=JSON.parse(JSON.stringify(value));
    for(const k of ['region','community','settlement'])if(v[k]&&(!code.test(v[k].code)||typeof v[k].name!=='string'||v[k].name.length>240))return null;
    if(v.stage!=='region'&&!v.region||['route','done'].includes(v.stage)&&(!v.settlement||v.settlement.region?.code!==v.region.code)||v.community&&v.community.region?.code!==v.region?.code||v.route&&(typeof v.route.routeId!=='string'||v.route.routeId.length>350)||v.stage==='done'&&!v.route)return null;
    return v;
  }
  function create({get,render,remember,onCity,onLegacy}){
    let serial=0,controller=null,timer=null,view={items:[],cursor:null,loading:false,error:null};
    const current=()=>get()?.geography,active=()=>!!current()&&!get().city&&get().phase==='address';
    function cancel(){serial++;controller?.abort();controller=null;clearTimeout(timer);timer=null;view={items:[],cursor:null,loading:false,error:null};}
    function title(){return {region:'У якій області шукаємо адресу?',community:'У якій громаді?',settlement:'Оберіть населений пункт',route:'У якому відділенні перевірити адресу?'}[current()?.stage]||'Оберіть місце';}
    function context(x){return [x.type==='city'?'місто':x.type==='village'?'село':x.type==='settlement'?'селище':null,x.district?.name,x.type==='community'?null:x.community?.name].filter(Boolean).join(' · ');}
    function resultsHTML(){
      const g=current();if(!g)return '';
      if(view.error)return '<p class="onboard-support" role="status">Не вдалося завантажити довідник. Спробуйте ще раз.</p><button class="action" data-action="geo-retry">Спробувати ще</button>';
      let html=view.items.map(x=>{
        const route=g.stage==='route',label=route?[x.operator.label,x.branch?.name].filter(Boolean).join(' · '):x.name;
        const detail=route?[x.providerCity.name,x.matchState==='candidate'?'Перевіримо за вулицею й будинком':null,x.candidateSettlements>1?'У довіднику є однакові назви населених пунктів':null].filter(Boolean).join(' · '):context(x);
        return `<button class="onboard-result geo-result" aria-label="${esc(label+(detail?', '+detail:''))}" data-action="geo-select" data-key="${esc(route?x.routeId:x.code)}"><strong>${esc(label)}</strong>${detail?`<small>${esc(detail)}</small>`:''}</button>`;
      }).join('');
      if(!view.items.length&&!view.loading){
        html+=`<p class="onboard-support" role="status">${g.stage==='route'?'Для цього населеного пункту ще немає підтвердженого відділення в підключених джерелах.':g.query?'За цим запитом нічого не знайдено. Перевірте назву або змініть попередній вибір.':'Список поки порожній.'}</p>`;
      }
      if(view.loading)html+='<p class="onboard-support" role="status" aria-live="polite">Завантажую…</p>';
      if(view.cursor)html+=`<button class="action geo-more" data-action="geo-more" ${view.loading?'disabled':''}>Показати ще</button>`;
      return html;
    }
    function paint(){const node=document.getElementById('geo-results');if(node){node.innerHTML=resultsHTML();node.setAttribute('aria-busy',String(view.loading));}}
    async function load(more=false){
      if(!active())return;const flow=get(),g=current(),cursor=more?view.cursor:null;if(more&&!cursor)return;
      controller?.abort();controller=new AbortController();const seq=++serial;view={items:more?view.items:[],cursor:null,loading:true,error:null};paint();
      try{
        let response;
        if(g.stage==='route')response=await window.SvitloLive.geography('settlement-routes',{settlementCode:g.settlement.code},controller.signal);
        else response=await window.SvitloLive.geography('settlements',{kind:{region:'regions',community:'communities',settlement:'settlements'}[g.stage],q:g.query,limit:50,...(g.stage!=='region'?{regionCode:g.region.code}:{}),...(g.stage==='settlement'&&g.community?{communityCode:g.community.code}:{}),...(cursor?{cursor}:{})},controller.signal);
        if(get()!==flow||current()!==g||seq!==serial)return;
        const items=g.stage==='route'?response.routes:response.items;
        if(!Array.isArray(items))throw Error('invalid geography response');
        view={items:more?[...new Map([...view.items,...items].map(x=>[x.code||x.routeId,x])).values()]:items,cursor:response.nextCursor||null,loading:false,error:null};paint();remember();
      }catch(e){if(get()!==flow||current()!==g||seq!==serial||e.name==='AbortError')return;view={items:[],cursor:null,loading:false,error:true};paint();}
    }
    function start(){cancel();if(active()){render(false);queueMicrotask(()=>load());}}
    function html(){
      const g=current(),crumbs=[g.region?.name,g.community?.name,g.settlement?.name].filter(Boolean);
      return `<section class="onboard-address-flow geo-address-flow" aria-label="Місце нової адреси"><h1>${title()}</h1>${crumbs.length?`<p class="geo-breadcrumb">${crumbs.map(esc).join(' · ')}</p>`:''}<div class="card outlined onboard-card">${g.stage!=='route'?`<label class="onboard-label" for="geo-query">${{region:'Область або місто зі спеціальним статусом',community:'Громада',settlement:'Населений пункт'}[g.stage]}</label><input id="geo-query" class="field" type="search" data-geo-query maxlength="120" autocomplete="off" spellcheck="false" value="${esc(g.query)}" placeholder="Введіть назву">`:''}<div id="geo-results" class="onboard-results geo-results" aria-busy="${view.loading}">${resultsHTML()}</div>${g.stage==='community'?'<button class="action geo-secondary" data-action="geo-skip-community">Не знаю громаду</button>':''}${g.stage!=='region'?'<button class="action geo-secondary" data-action="geo-back">Назад</button>':''}${!get().initial?'<button class="action geo-secondary" data-action="onboard-cancel">Скасувати додавання</button>':''}</div></section>`;
    }
    async function select(key){
      if(!active()||view.loading)return;const flow=get(),g=current(),record=view.items.find(x=>(x.code||x.routeId)===key);if(!record)return;
      if(g.stage==='route'){
        controller?.abort();controller=new AbortController();const seq=++serial;view.loading=true;paint();
        try{const result=await window.SvitloLive.geography('settlement-catalog',{settlementCode:g.settlement.code,routeId:record.routeId},controller.signal);if(get()!==flow||current()!==g||seq!==serial)return;
          g.route=record;g.stage='done';g.query='';cancel();onCity({...result.city,name:result.city.label,context:[g.region.name,g.community?.name,record.branch?.name].filter(Boolean).join(' · ')});
        }catch(e){if(get()!==flow||current()!==g||seq!==serial||e.name==='AbortError')return;view.loading=false;view.error=true;paint();}return;
      }
      if(g.stage==='region'){g.region=record;g.community=null;g.settlement=null;g.route=null;if(record.category==='K'){g.settlement={...record,region:{code:record.code,name:record.name}};g.stage='route';}else g.stage='community';}
      else if(g.stage==='community'){g.community=record;g.settlement=null;g.route=null;g.stage='settlement';}
      else {g.settlement=record;g.community=record.community?{...record.community,region:record.region}:null;g.route=null;g.stage='route';}
      g.query='';start();
    }
    function handleAction(action,element){
      if(!action.startsWith('geo-'))return false;if(!active())return true;const g=current();
      if(action==='geo-select')select(element.dataset.key);
      else if(action==='geo-more')load(true);
      else if(action==='geo-retry')load();
      else if(action==='geo-skip-community'){g.community=null;g.stage='settlement';g.query='';start();}
      else if(action==='geo-back'){g.query='';g.route=null;if(g.stage==='route'&&g.region.category!=='K'){g.settlement=null;g.stage='settlement';}else if(g.stage==='settlement'){g.community=null;g.stage='community';}else{Object.assign(g,fresh());}start();}
      else if(action==='geo-legacy'){const name=g.settlement?.name||'';cancel();onLegacy(name);}
      return true;
    }
    function handleInput(event){if(!active()||!event.target.hasAttribute('data-geo-query'))return false;const g=current();g.query=event.target.value.slice(0,120);controller?.abort();serial++;clearTimeout(timer);view={items:[],cursor:null,loading:true,error:null};paint();remember();timer=setTimeout(()=>load(),250);return true;}
    return {active,html,start,cancel,handleAction,handleInput};
  }
  return {fresh,restore,create};
})();
