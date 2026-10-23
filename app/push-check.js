const output=document.querySelector('#result');
async function check(){try{const r=await navigator.serviceWorker.getRegistration('./');const sub=await r?.pushManager.getSubscription();const notifications=await r?.getNotifications()||[];output.textContent=`Дозвіл: ${Notification.permission}\nФоновий модуль: ${r?.active?.state||'не активний'}\nPush-підписка: ${sub?'є':'немає'}\nСтворені сповіщення: ${notifications.length}\n${notifications.map(n=>n.title).join('\n')}`;}catch(e){output.textContent='Перевірка недоступна: '+e.message;}}
document.querySelector('#refresh').onclick=check;
document.querySelector('#local').onclick=async()=>{try{const r=await navigator.serviceWorker.ready;await r.showNotification('Світло — перевірка показу',{body:'Локальна перевірка Chrome та системних налаштувань.',icon:new URL('icons/icon-192.png',location.href).href,tag:'svitlo-local-check'});await check();}catch(e){output.textContent='Браузер не зміг створити повідомлення: '+e.message;}};
check();
