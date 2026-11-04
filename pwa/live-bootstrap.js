"use strict";
window.SvitloLiveReady=import('./live-runtime.js').then(module=>module.createLive()).then(live=>{
  window.SvitloLive=live;
  window.SvitloScenarios={label:live.label,schedule:(_s,_d,_m,_r,_t,_f,c)=>live.schedule(c?.date,c?.addressKey),context:(_s,_d,_m,_r,_t,_today,_f,c)=>live.context(c?.date,c?.addressKey)};
  return live;
}).catch(error=>{
  document.getElementById('screen').innerHTML='<section class="card"><h2>Не вдалося відкрити «Світло»</h2><p>Перевірте з’єднання й оновіть сторінку.</p><button class="action" id="retry-start">Спробувати ще</button></section>';
  document.getElementById('retry-start').onclick=()=>location.reload();
  throw error;
});
