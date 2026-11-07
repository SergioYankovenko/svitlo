const SDK='https://accounts.google.com/gsi/client';
let pending;
export function loadGoogleIdentity(){
 if(globalThis.google?.accounts?.id)return Promise.resolve(globalThis.google.accounts.id);
 if(pending)return pending;
 pending=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src=SDK;script.async=true;
  let done=false;
  const finish=ok=>{
   if(done)return;done=true;clearTimeout(timer);
   const id=globalThis.google?.accounts?.id;
   if(ok&&id)resolve(id);else{script.remove();reject(Error('Google поки недоступний'));}
  };
  const timer=setTimeout(()=>finish(false),10000);
  script.onload=()=>finish(true);script.onerror=()=>finish(false);
  document.head.append(script);
 }).catch(error=>{pending=null;throw error;});
 return pending;
}
