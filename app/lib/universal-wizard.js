import {universalRequest} from '../api.js';
import {enhancePickers} from './pickers.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function universalWizard({dialog,currentOwner,isCurrent,save,onSaved}){
 const keys=['city','street','house'],labels={city:'Населений пункт',street:'Вулиця',house:'Будинок'},kinds={city:'cities',street:'streets',house:'houses'};
 const d=dialog('Додати адресу',`<form id="universal-address-form"><p class="muted">Оберіть місто й адресу. Оператора визначаємо автоматично.</p>${keys.map((key,i)=>`<section><label for="u-${key}-query">Пошук: ${labels[key].toLowerCase()}</label><input id="u-${key}-query" type="search" maxlength="120" autocomplete="off"${i?' disabled':''}><label for="u-${key}">${labels[key]}</label><select id="u-${key}" required disabled></select><button type="button" id="u-${key}-more" hidden>Показати ще</button><p id="u-${key}-state" class="muted" role="status"></p></section>`).join('')}<div id="u-preview"></div><p class="error" id="u-error" role="alert"></p></form>`);
 const el=id=>d.querySelector('#u-'+id),error=el('error'),state={},controllers=new Map();let scope,generation=0,resolved=null;
 d.addEventListener('close',()=>{generation++;for(const c of controllers.values())c.abort();for(const v of Object.values(state))clearTimeout(v.timer);},{once:true});
 try{scope=await currentOwner();if(!scope||!d.open)return;const caps=await universalRequest('capabilities');if(caps.schemaVersion!==1||caps.featureSet!=='universal')throw Error('Ця версія API не підтримує адресний пошук');}catch(e){error.textContent=e.message;return;}
 const active=()=>d.open&&isCurrent(scope);
 function clearAfter(key){resolved=null;generation++;el('preview').innerHTML='';for(const next of keys.slice(keys.indexOf(key)+1)){controllers.get(next)?.abort();el(next).innerHTML='';el(next).disabled=true;el(next+'-query').disabled=true;el(next+'-query').value='';el(next+'-more').hidden=true;el(next+'-state').textContent='';state[next]={};}}
 async function load(key,more=false){if(!active())return;const i=keys.indexOf(key),parentId=i?el(keys[i-1]).value:null;if(i&&!parentId)return;
  controllers.get(key)?.abort();const controller=new AbortController();controllers.set(key,controller);
  const q=el(key+'-query').value,old=state[key]||{},token=Symbol();state[key]={...old,token};
  el(key+'-state').textContent='Завантажуємо…';el(key+'-more').hidden=true;
  try{const r=await universalRequest('search',{kind:kinds[key],parentId,q,limit:50,cursor:more?old.cursor:null},{signal:controller.signal});
   if(!active()||state[key].token!==token)return;
   const selected=more?el(key).value:'';const items=more?[...(old.items||[]),...r.items]:r.items;state[key]={items,cursor:r.nextCursor,token};
   el(key).innerHTML='<option value="">Оберіть…</option>'+items.map(x=>`<option value="${esc(x.id)}">${esc(x.label+(x.districtVerified?' · '+x.district:''))}</option>`).join('');
   if(selected)el(key).value=selected;
   el(key).disabled=false;el(key+'-state').textContent=r.nextCursor?'Показано частину результатів. Уточніть пошук або завантажте ще.':items.length?'':'Нічого не знайдено';el(key+'-more').hidden=!r.nextCursor;error.textContent='';
  }catch(e){if(active()&&e.name!=='AbortError'){error.textContent=e.message;el(key+'-state').textContent='';}}
 }
 function preview(r){resolved=r;const selected=r.selection.lineId,lines=r.resolution.lines,oldName=el('name')?.value||'';
  el('preview').innerHTML=`<p>${esc(r.address.label)}</p><p class="muted">${esc(r.operator.label)}${r.operator.synthetic?' · СИНТЕТИЧНІ ТЕСТОВІ ДАНІ':''}</p>
   ${r.unitSupported&&lines.length>1?'<label for="u-unit">Квартира (лише для визначення лінії)</label><input id="u-unit" maxlength="32" autocomplete="off"><button type="button" id="u-unit-check">Визначити лінію за квартирою</button><p class="muted">Номер квартири не зберігаємо в профілі чи загальному каталозі.</p>':''}
   ${lines.length>1?`<label for="u-line">Лінія живлення</label><select id="u-line" required><option value="">Оберіть свою лінію…</option>${lines.map(l=>`<option value="${esc(l.id)}"${l.id===selected?' selected':''}>${esc(l.label+(l.groupCode?' · група '+l.groupCode:''))}</option>`).join('')}</select><p class="muted">Для будинку доступні різні лінії. Автоматично першу не обираємо.</p>`:`<p>${esc(r.resolution.state==='excluded'?'Адреса не включена до ГПВ':lines[0]?.groupCode?'Група '+lines[0].groupCode:lines.length?'Прямий адресний графік':'Лінію поки не визначено; доступні дані покажемо після збереження')}</p>`}
   ${r.operator.supportState==='disabled'||r.operator.supportState==='unsupported'?'<p class="error">Джерело цього регіону недоступне</p>':`<label for="u-name">Назва (необов’язково)</label><input id="u-name" maxlength="60" value="${esc(oldName)}" placeholder="Мій дім"><button type="submit" class="primary" id="u-save"${lines.length>1&&!selected?' disabled':''}>Так, це моя адреса</button>`}`;
  enhancePickers(d);
  if(el('line'))el('line').onchange=()=>{resolved.selection={lineId:el('line').value||null,mode:'user_selected'};el('save').disabled=!el('line').value;};
  if(el('unit-check'))el('unit-check').onclick=async()=>{const gen=++generation;try{const next=await universalRequest('resolve',{addressId:r.address.id,unit:el('unit').value});if(active()&&gen===generation)preview(next);}catch(e){if(active())error.textContent=e.message;}};
 }
 for(const key of keys){state[key]={};el(key+'-query').oninput=()=>{clearAfter(key);el(key).value='';clearTimeout(state[key].timer);state[key].timer=setTimeout(()=>load(key),250);};el(key+'-more').onclick=()=>load(key,true);
  el(key).onchange=async()=>{clearAfter(key);if(!el(key).value)return;const i=keys.indexOf(key);if(i<2){el(keys[i+1]+'-query').disabled=false;return load(keys[i+1]);}
   const gen=++generation;error.textContent='';el('preview').textContent='Перевіряємо адресу…';try{const r=await universalRequest('resolve',{addressId:el('house').value});if(active()&&generation===gen)preview(r);}catch(e){if(active()&&generation===gen){el('preview').innerHTML='';error.textContent=e.message;}}
  };
 }
 d.querySelector('form').onsubmit=async e=>{e.preventDefault();if(!active()||!resolved)return;const button=el('save');if(!button)return;button.disabled=true;button.textContent='Зберігаємо…';
  try{const r=await save(scope,{address:{canonicalAddressId:resolved.address.id,lineId:resolved.selection.lineId},name:el('name').value,confirmed:true});if(!active()||!r)return;await onSaved(r,scope);d.close();}
  catch(e){if(active()){error.textContent=e.message;button.disabled=false;button.textContent='Так, це моя адреса';}}
 };
 await load('city');
}
