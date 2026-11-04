"use strict";
// UI246: camera frames stay in memory. Only an explicitly confirmed structured sensor proof leaves this view.
window.SvitloSensorScanner = (() => {
  let active = null, decoder = null;
  function parse(raw) {
    if(typeof raw!=='string'||raw.length>512)return null;
    try {
      const q=JSON.parse(raw),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if(q.version!==1||!['phone_owner','factory_owner','viewer_invite'].includes(q.kind)||!uuid.test(q.sensorId)||Object.keys(q).some(k=>!['version','kind','sensorId','proof'].includes(k)))return null;
      const prefix={phone_owner:'sp_',factory_owner:'so_',viewer_invite:'si_'}[q.kind];
      return typeof q.proof==='string'&&new RegExp('^'+prefix+'[A-Za-z0-9_-]{43}$').test(q.proof)?JSON.stringify(q):null;
    }catch{return null;}
  }
  function loadDecoder() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (!decoder) decoder = new Promise((resolve,reject) => {
      const script = document.createElement("script");
      script.src = "vendor/jsQR-1.4.0.js";
      script.onload = () => window.jsQR ? resolve(window.jsQR) : reject(Error("decoder"));
      script.onerror = () => { script.remove(); decoder = null; reject(Error("decoder")); };
      document.head.append(script);
    });
    return decoder;
  }
  const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());
  function dispose() { active?.(); active = null; }
  function mount(root) {
    dispose();
    if (!root) return;
    const abort = new AbortController(), signal = abort.signal;
    const video = root.querySelector("video"), message = root.querySelector("[data-scan-message]"),
      input = root.querySelector("#sensor-code"), check = root.querySelector("[data-action=sensor-check]"),
      manual = root.querySelector("[data-scan-manual]"), camera = root.querySelector("[data-scan-camera]");
    let stream = null, timer = null, epoch = 0, code = null, mode = "camera", disposed = false;
    const setMessage = (text,state) => {message.textContent = text; root.dataset.scanState = state;};
    function stop() { epoch++; clearTimeout(timer); timer = null; stopTracks(stream); stream = null; video.srcObject = null; }
    function accept(raw) {
      const parsed = parse(raw);
      if (!parsed) { setMessage("Цей QR не підходить. Наведи камеру на код датчика.","invalid"); return false; }
      if (code) return true;
      code = parsed; input.value = parsed; check.disabled = false;
      stop(); setMessage("Код зчитано. Натисни «Перевірити».","ready");
      return true;
    }
    async function start() {
      stop(); code = null; input.value = ""; check.disabled = true; mode = "camera";
      manual.hidden = true; camera.hidden = false;
      setMessage("Дозволь доступ до камери, щоб сканувати QR.","permission");
      const token = epoch;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setMessage("Камера недоступна. Можеш ввести код вручну.","unavailable"); return;
      }
      try {
        const granted = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:640},height:{ideal:480}}});
        if (disposed || token !== epoch || !root.isConnected) { stopTracks(granted); return; }
        stream = granted; video.srcObject = granted;
        stream.getVideoTracks().forEach(track => track.addEventListener("ended",() => {
          if (!disposed && token === epoch) { stop(); setMessage("Камеру вимкнено. Спробуй ще або введи код.","unavailable"); }
        },{signal}));
        await video.play();
        const decode = await loadDecoder();
        if (disposed || token !== epoch) return;
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d",{willReadFrequently:true});
        setMessage("Наведи камеру на QR-код датчика.","scanning");
        async function scan() {
          if (disposed || token !== epoch || code || !root.isConnected) return;
          try {
            if (video.readyState >= 2 && video.videoWidth) {
              const scale = Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
              canvas.width = Math.round(video.videoWidth*scale); canvas.height = Math.round(video.videoHeight*scale);
              context.drawImage(video,0,0,canvas.width,canvas.height);
              const pixels = context.getImageData(0,0,canvas.width,canvas.height);
              const result = decode(pixels.data,pixels.width,pixels.height,{inversionAttempts:"attemptBoth"});
              if (result && accept(result.data)) { canvas.width = canvas.height = 0; return; }
            }
          } catch { stop(); setMessage("Не вдалося прочитати камеру. Введи код вручну.","unavailable"); return; }
          timer = setTimeout(scan,300);
        }
        scan();
      } catch (error) {
        if (disposed || token !== epoch) return;
        stop();
        setMessage(error?.name === "NotAllowedError" ? "Доступ до камери не надано. Введи код або дозволь камеру в налаштуваннях." : "Камера недоступна або зайнята. Спробуй ще чи введи код.","unavailable");
      }
    }
    root.querySelector("[data-scan-enter]").addEventListener("click",() => {
      stop(); code = null; mode = "manual"; check.disabled = true; input.value = "";
      camera.hidden = true; manual.hidden = false;
      setMessage("Введи код датчика.","manual"); input.focus({preventScroll:true});
    },{signal});
    root.querySelector("[data-scan-retry]").addEventListener("click",start,{signal});
    root.querySelector("[data-scan-resume]").addEventListener("click",start,{signal});
    input.addEventListener("input",() => {code = null; check.disabled = !input.value.trim();},{signal});
    // Pause on backgrounding; never reacquire the camera without another user action.
    const pause = () => {if (!disposed) {stop(); if (mode === "camera" && !code) setMessage("Камеру призупинено. Натисни «Сканувати ще».","paused");}};
    document.addEventListener("visibilitychange",() => {if (document.hidden) pause();},{signal});
    window.addEventListener("pagehide",pause,{signal});
    active = () => {disposed = true; stop(); input.value = ""; abort.abort();};
    start();
  }
  const html = () => `<div class="sensor-scanner"><div class="sensor-camera" data-scan-camera><video muted playsinline aria-label="Камера для сканування QR"></video><span class="sensor-scan-frame" aria-hidden="true"></span></div><div data-scan-manual hidden><label for="sensor-code">Код датчика</label><input class="field" id="sensor-code" maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" class="dialog-action center" data-scan-resume>Сканувати QR</button></div><p data-scan-message role="status" aria-live="polite"></p><div class="sensor-scanner-tools"><button type="button" class="dialog-action center" data-scan-enter>Ввести код</button><button type="button" class="dialog-action center" data-scan-retry>Сканувати ще</button></div><small class="muted">Кадри камери не зберігаються й не надсилаються на сервер</small></div>`;
  return {parse,html,mount,dispose};
})();
