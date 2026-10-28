// Apply a saved, whitelisted theme before the stylesheet paints the shell.
(() => {
  let theme='dark';
  try{if(JSON.parse(localStorage.getItem('svitlo-theme'))==='light')theme='light';}catch{}
  document.documentElement.dataset.theme=theme;
  document.querySelector('meta[name="theme-color"]').content=theme==='light'?'#eff5ec':'#14251e';
})();

// Old workers used network-first HTML and cache-first modules. Do not start a
// newer document against that worker's older module set during the first upgrade.
(() => {
  const source=document.currentScript,expected=source.dataset.shell,url=new URL('./main.js',source.src);
  let started=false;
  const ready=()=>document.readyState==='loading'?new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true})):Promise.resolve();
  const start=async()=>{await ready();if(started)return;started=true;const script=document.createElement('script');script.type='module';script.src=url;document.body.append(script);};
  const version=worker=>new Promise(resolve=>{
    if(!worker)return resolve(null);
    const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();resolve(null);},600);
    channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();resolve(event.data?.cache);};
    try{worker.postMessage({type:'svitlo-shell-version'},[channel.port2]);}catch{clearTimeout(timer);channel.port1.close();resolve(null);}
  });
  const check=async()=>{if(await version(navigator.serviceWorker.controller)===expected){void start();return true;}return false;};
  if(!navigator.serviceWorker?.controller||expected==='development'){void start();return;}
  navigator.serviceWorker.addEventListener('controllerchange',()=>void check());
  void(async()=>{
    if(await check())return;
    const timer=setTimeout(async()=>{await ready();if(!started)document.querySelector('#app').textContent='Оновлення недоступне. Закрийте всі вікна «Світло» та відкрийте знову.';},8000);
    try{
      const registration=await navigator.serviceWorker.register(new URL('./sw.js',source.src),{scope:new URL('./',source.src).pathname,updateViaCache:'none'});
      await ready();
      if(!await check()&&!started)document.querySelector('#app').textContent='Нова версія готова. Закрийте всі вікна «Світло» та відкрийте знову.';
      registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',()=>void check()));
    }catch{await ready();if(!started)document.querySelector('#app').textContent='Оновлення недоступне. Закрийте всі вікна «Світло» та відкрийте знову.';}
    finally{clearTimeout(timer);}
  })();
})();
