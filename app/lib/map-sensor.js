import {sensorRequest} from '../api.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function sensorSignalView(signal,elapsedMs=0){
 const server=Date.parse(signal?.serverTime),confirmed=Date.parse(signal?.lastConfirmedAt),received=Date.parse(signal?.lastReceivedAt),ttl=signal?.freshnessSeconds*1000;
 const remaining=Math.min(confirmed+ttl,received+ttl)-server-Math.max(0,elapsedMs);
 const fresh=Number.isFinite(remaining)&&remaining>0&&signal.availability==='available'&&signal.freshness==='fresh'&&signal.transportState==='online'&&signal.clockQuality==='synchronized';
 return fresh&&['on','off'].includes(signal.powerState)?{state:signal.powerState,label:signal.powerState==='on'?'Є живлення за датчиком':'Немає живлення за датчиком'}:{state:'unknown',label:'Стан живлення невідомий'};
}
export async function mapSensorDialog({dialog,profile,currentOwner,isCurrent}){
 const d=dialog('Датчик за адресою',`<p>${esc(profile.address.label)}</p><p id="map-sensor-state" role="status">Перевіряємо прив’язку…</p><div id="map-sensor-form"></div>`);
 const controller=new AbortController();let timer;d.addEventListener('close',()=>{controller.abort();clearInterval(timer);},{once:true});
 let scope;const active=()=>d.open&&scope&&isCurrent(scope),state=d.querySelector('#map-sensor-state'),form=d.querySelector('#map-sensor-form');
 async function showSignal(linked){
  form.innerHTML='<button type="button">Оновити стан датчика</button><p class="muted">Стан стосується прив’язаного датчика. Приблизне місце на карті не підтверджує живлення сусідніх будинків.</p>';
  const button=form.querySelector('button');
  async function refresh(){if(!active())return;button.disabled=true;clearInterval(timer);state.textContent='Датчик прив’язано. Перевіряємо стан живлення…';const fetchedAt=Date.now();
   try{const result=await sensorRequest('signal',{sensorId:linked.sensorId,bindingEpoch:linked.bindingEpoch},{owner:scope.owner,signal:controller.signal});if(!active())return;
    const signal=result.signal;if(signal?.sensorId!==linked.sensorId||signal.bindingEpoch!==linked.bindingEpoch)throw Error('Signal mismatch');
    const render=()=>{if(!active()){state.textContent='Оновіть перевірку доступу до датчика';clearInterval(timer);return;}const view=sensorSignalView(signal,Date.now()-fetchedAt);state.textContent=view.label+(signal.isTest?' · тестовий датчик':'')+(view.state==='unknown'?'. Немає свіжого підтвердження.':'');};render();timer=setInterval(render,1000);
   }catch(e){if(active()&&e.name!=='AbortError')state.textContent='Датчик прив’язано. Стан живлення зараз недоступний. Спробуйте оновити.';}
   finally{if(active())button.disabled=false;}
  }
  button.onclick=refresh;await refresh();
 }
 try{scope=await currentOwner();if(!active())return;
  const result=await sensorRequest('list',{}, {owner:scope.owner,signal:controller.signal});if(!active())return;
  const linked=result.sensors?.find(s=>s.readerProfileId===profile.id);
  if(linked){await showSignal(linked);return;}
  state.textContent='Вкажіть код підключення вашого датчика. Точне розташування будинку для прив’язки не потрібне.';
  form.innerHTML='<form><label for="map-sensor-code">Код підключення датчика</label><input id="map-sensor-code" type="password" autocomplete="off" maxlength="46" required><button class="primary" type="submit">Прив’язати датчик</button><p class="error" role="alert"></p></form>';
  let pendingId=null,lastCode=null;
  form.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button'),input=form.querySelector('input'),error=form.querySelector('[role=alert]');
   if(!/^sc_[A-Za-z0-9_-]{43}$/.test(input.value)){error.textContent='Перевірте код підключення датчика';return;}button.disabled=true;error.textContent='';
   if(lastCode!==input.value){lastCode=input.value;pendingId=crypto.randomUUID();}
   try{const result=await sensorRequest('claim',{requestId:pendingId,claimToken:input.value,profileId:profile.id},{owner:scope.owner,signal:controller.signal});input.value='';lastCode=null;pendingId=null;if(!active())return;
    await showSignal(result.sensor);
   }catch(e){if(active()&&e.name!=='AbortError'){input.value='';error.textContent=e.status===409?'До цієї адреси вже прив’язано датчик або прив’язка потребує уточнення.':'Не вдалося підключити датчик. Перевірте код і спробуйте ще раз.';button.disabled=false;}}
  };
 }catch(e){if(active()&&e.name!=='AbortError')state.textContent='Не вдалося перевірити прив’язку. Спробуйте пізніше.';}
}
