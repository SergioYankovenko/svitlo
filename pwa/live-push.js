// Browser registration can outlive the page operation. Bound waiting without pretending to cancel it.
export async function subscribeWithTimeout(manager,options,{timeout=20000,onLate=()=>{}}={}){
  let timer,expired=false;
  const operation=Promise.resolve().then(()=>manager.subscribe(options));
  operation.then(subscription=>{if(expired)Promise.resolve(onLate(subscription)).catch(()=>{});},()=>{});
  try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('Не вдалося підключити сповіщення'));},timeout);})]);}
  finally{clearTimeout(timer);}
}
