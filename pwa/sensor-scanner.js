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
  function mount(root,{onCode=()=>{},onState=()=>{},onDispose=()=>{}}={}) {
    dispose();if(!root)return;
    const abort=new AbortController(),signal=abort.signal,
      video=root.querySelector('video'),still=root.querySelector('[data-scan-still]'),message=root.querySelector('[data-scan-message]'),
      digits=[...root.querySelectorAll('[data-sensor-digit]')],manual=root.querySelector('[data-scan-manual]'),
      enter=root.querySelector('[data-scan-enter]'),camera=root.querySelector('[data-scan-camera]'),
      frame=root.querySelector('[data-scan-corners]'),unavailable=root.querySelector('[data-camera-unavailable]');
    let stream=null,timer=null,epoch=0,code=null,disposed=false,busy=false;
    const present=(text,state)=>{message.textContent=text;root.dataset.scanState=state;onState(state);};
    function stop(){epoch++;clearTimeout(timer);timer=null;stopTracks(stream);stream=null;video.srcObject=null;}
    function noCamera(){
      stop();video.hidden=true;frame.setAttribute('hidden','');unavailable.hidden=false;enter.hidden=false;
      present('Камера недоступна','unavailable');
    }
    function accept(raw,fromCamera,captured){
      if(busy)return false;
      const parsed=parse(raw);
      if(!parsed){
        if(fromCamera){enter.hidden=false;present('Цей QR не підходить. Наведи камеру на код датчика.','invalid');}
        return false;
      }
      if(code===parsed)return true;
      if(fromCamera&&captured){
        still.width=captured.width;still.height=captured.height;
        still.getContext('2d').drawImage(captured,0,0);still.hidden=false;video.hidden=true;
      }
      code=parsed;stop();enter.hidden=true;present('Код зчитано. Підтвердь підключення.','ready');
      queueMicrotask(()=>{if(!disposed&&root.isConnected&&code===parsed)onCode(parsed);});return true;
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
        camera.style.setProperty('--scan-height',camera.clientHeight+'px');
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
              if(result&&accept(result.data,true,canvas)){canvas.width=canvas.height=0;return;}
            }
          }catch{noCamera();return;}
          timer=setTimeout(scan,200);
        }
        scan();
      }catch{if(!disposed&&token===epoch)noCamera();}
    }
    function manualEntry(){
      stop();still.hidden=true;still.width=still.height=0;code=null;camera.hidden=true;enter.hidden=true;manual.hidden=false;
      digits.forEach(input=>input.value='');
      present('Введи 6 цифр коду.','manual');digits[0]?.focus({preventScroll:true});
    }
    enter.addEventListener('click',manualEntry,{signal});
    const focusDigit=index=>{digits[index]?.focus({preventScroll:true});digits[index]?.select?.();};
    const changed=()=>{
      if(digits.every(input=>/^[0-9]$/.test(input.value))&&accept(digits.map(input=>input.value).join(''),false))return;
      code=null;
      present('Введи 6 цифр коду.','manual');
    };
    digits.forEach((input,index)=>{
      input.addEventListener('beforeinput',event=>{
        if(busy||event.data!=null&&!/^[0-9]+$/.test(event.data))event.preventDefault();
      },{signal});
      input.addEventListener('input',()=>{
        if(busy)return;
        // Defensive filtering also covers autofill/IME paths without beforeinput.
        const value=/^[0-9]*$/.test(input.value)?input.value.slice(0,6-index):'';
        input.value=value[0]||'';
        for(let offset=1;offset<value.length;offset++)digits[index+offset].value=value[offset];
        changed();if(value)focusDigit(Math.min(5,index+value.length));
      },{signal});
      input.addEventListener('paste',event=>{
        event.preventDefault();if(busy)return;
        const value=event.clipboardData?.getData('text')?.trim()||'';
        if(!/^[0-9]{1,6}$/.test(value))return;
        const start=value.length===6?0:index;
        for(let offset=0;offset<value.length&&start+offset<6;offset++)digits[start+offset].value=value[offset];
        changed();focusDigit(Math.min(5,start+value.length));
      },{signal});
      input.addEventListener('keydown',event=>{
        if(busy)return;
        if(event.key==='Backspace'&&!input.value&&index>0){event.preventDefault();digits[index-1].value='';changed();focusDigit(index-1);}
        else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();focusDigit(Math.max(0,Math.min(5,index+(event.key==='ArrowLeft'?-1:1))));}
        else if(event.key==='Home'||event.key==='End'){event.preventDefault();focusDigit(event.key==='Home'?0:5);}
      },{signal});
    });
    const pause=()=>{if(!disposed&&!code&&manual.hidden)noCamera();};
    document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();},{signal});
    window.addEventListener('pagehide',pause,{signal});
    active=()=>{disposed=true;stop();still.hidden=true;still.width=still.height=0;digits.forEach(input=>input.value='');code=null;abort.abort();onDispose();};start();
    return {
      manual:manualEntry,pause:stop,
      setBusy(value){busy=!!value;digits.forEach(input=>input.disabled=busy);},
      rejected(){if(!disposed){enter.hidden=!manual.hidden;root.dataset.scanState='error';}},
    };
  }
  const html=()=>`<div class="sensor-scanner"><div class="sensor-camera" data-scan-camera><video muted playsinline aria-label="Камера для сканування QR"></video><canvas class="sensor-scan-still" data-scan-still hidden role="img" aria-label="Зчитаний QR-код датчика"></canvas><span class="sensor-scan-sweep" aria-hidden="true"></span><svg class="sensor-qr-corners" data-scan-corners viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M27,21V14H34 M66,14H73V21 M73,79V86H66 M34,86H27V79"/></svg><span class="sensor-camera-unavailable" data-camera-unavailable hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l2-3h6l2 3h3v13H4ZM3 3l19 19M10 10a4 4 0 0 0 5 5"/></svg><strong>Камера недоступна</strong></span></div><div data-scan-manual hidden><div class="sensor-code-digits" role="group" aria-label="Шестизначний код датчика">${Array.from({length:6},(_,index)=>`<input class="sensor-code-digit" data-sensor-digit="${index}" id="sensor-code${index?"-"+index:""}" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="${index===0?"one-time-code":"off"}" autocapitalize="off" spellcheck="false" aria-label="Цифра ${index+1} з 6">`).join("")}</div></div><p data-scan-message role="status" aria-live="polite"></p><button type="button" class="dialog-action center" data-scan-enter hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/></svg>Ввести вручну</button></div>`;
  return {parse,crop,cornerPath,html,mount,dispose};
})();
