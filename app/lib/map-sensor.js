import {sensorRequest} from '../api.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function mapSensorDialog({dialog,profile,currentOwner,isCurrent}){
 const d=dialog('Датчик за адресою',`<p>${esc(profile.address.label)}</p><p id="map-sensor-state" role="status">Перевіряємо прив’язку…</p><div id="map-sensor-form"></div>`);
 const controller=new AbortController();d.addEventListener('close',()=>controller.abort(),{once:true});
 let scope;const active=()=>d.open&&scope&&isCurrent(scope),state=d.querySelector('#map-sensor-state'),form=d.querySelector('#map-sensor-form');
 try{scope=await currentOwner();if(!active())return;
  const result=await sensorRequest('list',{}, {owner:scope.owner,signal:controller.signal});if(!active())return;
  const linked=result.sensors?.find(s=>s.readerProfileId===profile.id);
  if(linked){state.textContent='Датчик прив’язано до цієї адреси. Дані живлення поки недоступні у тестовій версії.';return;}
  state.textContent='Вкажіть код підключення вашого датчика. Точне розташування будинку для прив’язки не потрібне.';
  form.innerHTML='<form><label for="map-sensor-code">Код підключення датчика</label><input id="map-sensor-code" type="password" autocomplete="off" maxlength="46" required><button class="primary" type="submit">Прив’язати датчик</button><p class="error" role="alert"></p></form>';
  let pendingId=null,lastCode=null;
  form.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button'),input=form.querySelector('input'),error=form.querySelector('[role=alert]');
   if(!/^sc_[A-Za-z0-9_-]{43}$/.test(input.value)){error.textContent='Перевірте код підключення датчика';return;}button.disabled=true;error.textContent='';
   if(lastCode!==input.value){lastCode=input.value;pendingId=crypto.randomUUID();}
   try{await sensorRequest('claim',{requestId:pendingId,claimToken:input.value,profileId:profile.id},{owner:scope.owner,signal:controller.signal});input.value='';lastCode=null;pendingId=null;if(!active())return;
    form.innerHTML='';state.textContent='Датчик прив’язано до цієї адреси. Дані живлення поки недоступні у тестовій версії.';
   }catch(e){if(active()&&e.name!=='AbortError'){input.value='';error.textContent=e.status===409?'До цієї адреси вже прив’язано датчик або прив’язка потребує уточнення.':'Не вдалося підключити датчик. Перевірте код і спробуйте ще раз.';button.disabled=false;}}
  };
 }catch(e){if(active()&&e.name!=='AbortError')state.textContent='Не вдалося перевірити прив’язку. Спробуйте пізніше.';}
}
