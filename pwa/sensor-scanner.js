"use strict";
// Frames and detected corners stay local. Only a confirmed structured proof reaches the API.
window.SvitloSensorScanner = (() => {
  let active = null, decoder = null;
  function parse(raw) {
    if(typeof raw!=='string'||raw.length>512)return null;
    if(/^[0-9]{6}$/.test(raw.trim()))return JSON.stringify({version:1,kind:'phone_code',code:raw.trim()});
    try {
      const q=JSON.parse(raw),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if(q?.kind==='phone_code')return q.version===1&&typeof q.code==='string'&&/^[0-9]{6}$/.test(q.code)&&Object.keys(q).length===3&&Object.keys(q).every(k=>['version','kind','code'].includes(k))?JSON.stringify(q):null;
      if(q.version!==1||!['phone_owner','factory_owner','viewer_invite'].includes(q.kind)||!uuid.test(q.sensorId)||Object.keys(q).some(k=>!['version','kind','sensorId','proof'].includes(k)))return null;
      const prefix={phone_owner:'sp_',factory_owner:'so_',viewer_invite:'si_'}[q.kind];
      return typeof q.proof==='string'&&new RegExp('^'+prefix+'[A-Za-z0-9_-]{43}$').test(q.proof)?JSON.stringify(q):null;
    }catch{return null;}
  }
  function loadDecoder() {
    if(window.jsQR)return Promise.resolve(window.jsQR);
    if(!decoder)decoder=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='vendor/jsQR-1.4.0.js';
      script.onload=()=>window.jsQR?resolve(window.jsQR):reject(Error('decoder'));
      script.onerror=()=>{script.remove();decoder=null;reject(Error('decoder'));};document.head.append(script);
    });
    return decoder;
  }
  // The decoding canvas covers exactly the visible object-fit:cover preview.
  function crop(sw,sh,w,h) {
    const ratio=Math.max(w/sw,h/sh),width=w/ratio,height=h/ratio;
    return {x:(sw-width)/2,y:(sh-height)/2,width,height};
  }
  function cornerPath(location,w,h) {
    const points=[location.topLeftCorner,location.topRightCorner,location.bottomRightCorner,location.bottomLeftCorner];
    if(!points.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y))||!w||!h)return '';
    const percent=p=>(100*p.x/w).toFixed(3)+','+(100*p.y/h).toFixed(3);
    return points.map((p,i)=>{
      const along=other=>{const length=Math.hypot(other.x-p.x,other.y-p.y),t=length?Math.min(.24,18/length):0;return{x:p.x+(other.x-p.x)*t,y:p.y+(other.y-p.y)*t};};
      return 'M'+percent(along(points[(i+3)%4]))+' L'+percent(p)+' L'+percent(along(points[(i+1)%4]));
    }).join(' ');
  }
  const stopTracks=stream=>stream?.getTracks().forEach(track=>track.stop());
  function dispose(){active?.();active=null;}
  function mount(root,{onCode=()=>{}}={}) {
    dispose();if(!root)return;
    const abort=new AbortController(),signal=abort.signal,
      video=root.querySelector('video'),message=root.querySelector('[data-scan-message]'),
      input=root.querySelector('#sensor-code'),manual=root.querySelector('[data-scan-manual]'),
      enter=root.querySelector('[data-scan-enter]'),camera=root.querySelector('[data-scan-camera]'),
      frame=root.querySelector('[data-scan-corners]'),unavailable=root.querySelector('[data-camera-unavailable]');
    let stream=null,timer=null,epoch=0,code=null,disposed=false;
    const present=(text,state)=>{message.textContent=text;root.dataset.scanState=state;};
    function stop(){epoch++;clearTimeout(timer);timer=null;stopTracks(stream);stream=null;video.srcObject=null;}
    function noCamera(){
      stop();video.hidden=true;frame.setAttribute('hidden','');unavailable.hidden=false;enter.hidden=false;
      present('Камера недоступна','unavailable');
    }
    function accept(raw,fromCamera){
      const parsed=parse(raw);
      if(!parsed){
        if(fromCamera){enter.hidden=false;present('Цей QR не підходить. Наведи камеру на код датчика.','invalid');}
        return false;
      }
      if(code)return true;
      code=parsed;input.value=parsed;stop();enter.hidden=true;present('Код зчитано. Перевіряю…','ready');
      queueMicrotask(()=>{if(!disposed&&root.isConnected)onCode(parsed);});return true;
    }
    async function start(){
      const token=++epoch;
      if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)return noCamera();
      present('Наведи камеру на QR-код датчика.','permission');
      try{
        const granted=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
        if(disposed||token!==epoch||!root.isConnected){stopTracks(granted);return;}
        stream=granted;video.srcObject=granted;
        stream.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{if(!disposed&&token===epoch)noCamera();},{signal}));
        await video.play();const decode=await loadDecoder();if(disposed||token!==epoch)return;
        const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
        present('Наведи камеру на QR-код датчика.','scanning');
        function scan(){
          if(disposed||token!==epoch||code||!root.isConnected)return;
          try{
            if(video.readyState>=2&&video.videoWidth&&camera.clientWidth&&camera.clientHeight){
              const rect=crop(video.videoWidth,video.videoHeight,camera.clientWidth,camera.clientHeight),scale=Math.min(1,960/Math.max(rect.width,rect.height));
              canvas.width=Math.round(rect.width*scale);canvas.height=Math.round(rect.height*scale);
              context.drawImage(video,rect.x,rect.y,rect.width,rect.height,0,0,canvas.width,canvas.height);
              const pixels=context.getImageData(0,0,canvas.width,canvas.height),result=decode(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'});
              frame.querySelector('path').setAttribute('d',result?cornerPath(result.location,canvas.width,canvas.height):'M27,21V14H34 M66,14H73V21 M73,79V86H66 M34,86H27V79');
              frame.dataset.tracking=String(!!result);
              if(result&&accept(result.data,true)){canvas.width=canvas.height=0;return;}
            }
          }catch{noCamera();return;}
          timer=setTimeout(scan,200);
        }
        scan();
      }catch{if(!disposed&&token===epoch)noCamera();}
    }
    enter.addEventListener('click',()=>{
      stop();camera.hidden=true;enter.hidden=true;manual.hidden=false;
      present('Введи код датчика.','manual');input.focus({preventScroll:true});
    },{signal});
    input.addEventListener('input',()=>{
      if(accept(input.value,false))return;
      present(input.value.trim()?'Код неправильний або неповний.':'Введи код датчика.','manual');
    },{signal});
    const pause=()=>{if(!disposed&&!code&&manual.hidden)noCamera();};
    document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();},{signal});
    window.addEventListener('pagehide',pause,{signal});
    active=()=>{disposed=true;stop();input.value='';abort.abort();};start();
  }
  const html=()=>`<div class="sensor-scanner"><div class="sensor-camera" data-scan-camera><video muted playsinline aria-label="Камера для сканування QR"></video><svg class="sensor-qr-corners" data-scan-corners viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M27,21V14H34 M66,14H73V21 M73,79V86H66 M34,86H27V79"/></svg><span class="sensor-camera-unavailable" data-camera-unavailable hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l2-3h6l2 3h3v13H4ZM3 3l19 19M10 10a4 4 0 0 0 5 5"/></svg><strong>Камера недоступна</strong></span></div><div data-scan-manual hidden><label for="sensor-code">Код датчика</label><textarea class="field" id="sensor-code" rows="4" maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></div><p data-scan-message role="status" aria-live="polite"></p><button type="button" class="dialog-action center" data-scan-enter hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/></svg>Ввести вручну</button></div>`;
  return {parse,crop,cornerPath,html,mount,dispose};
})();
