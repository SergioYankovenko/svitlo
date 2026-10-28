import {powerIcon, themeIcon, checkIcon} from './icons.js';
import {dayState,dataReason} from './schedule.js';
import {dayKey,fresh} from './time.js';
import {preferences} from './notifications.js';
import {categoryPriority,eventKind} from './outage-types.js';
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function scheduleNotice(day,currentLabel) {
  const text=dataReason(day);
  return day.reason==='stale' || day.reason==='no_queue' && text===currentLabel ? '' : text;
}
export function addressLines(p,list=false) {
  const title=p.name||p.address.city, detail=p.name?p.address.label:(p.address.street ? p.address.street+', '+p.address.house : p.address.label.replace(p.address.city+', ',''));
  return `<span class="address-copy"><span class="address-name">${esc(title)}</span><span class="address-detail">${esc(detail)}</span></span>`;
}
export function addressCard(p,profiles,open) {
  const selected=profiles.length>1 ? `<button class="address-trigger" aria-expanded="${open}" aria-controls="address-list" aria-label="Обрати адресу: ${esc(p.name||p.address.label)}">${addressLines(p)}<svg class="address-chevron" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m8 ${open?20:12} 8 ${open?-8:8} 8 ${open?8:-8}"/></svg></button>` : `<div class="address-static">${addressLines(p)}</div>`;
  return `<section class="card address">${selected}${open&&profiles.length>1?`<div id="address-list" class="address-list" aria-label="Ваші адреси">${profiles.map(x=>`<button class="address-option" data-profile="${esc(x.id)}" aria-pressed="${x.id===p.id}">${addressLines(x,true)}<span class="address-check" aria-hidden="true">${x.id===p.id?checkIcon():''}</span></button>`).join('')}</div>`:''}<div class="row fit-pair"><button data-action="add">Додати адресу</button><button data-action="manage">Керувати адресами</button></div></section>`;
}
export function outageCategory(snapshot,date,now,header=false) {
  if(header) {
    const s=dayState(snapshot,dayKey(now),now);
    const confirmed=e=> {
      if(e.category==='hourly'&&s.plan&&!s.plan.uncertain)return !snapshot.feedFailed&&fresh(s.plan.checkedAt||snapshot.feedCheckedAt,now);
      const c=snapshot?.categories?.[e.category];return !snapshot?.failures?.includes(e.category)&&fresh(c?.checkedAt,now)&&fresh(c?.sourceAt,now);
    };
    const priority=categoryPriority;
    const events=s.events.filter(e=>confirmed(e)&&(e.end===null||e.end>now)).sort((a,b)=>(a.start<=now?0:1)-(b.start<=now?0:1)|| (a.start<=now&&b.start<=now ? priority[b.category]-priority[a.category] : a.start-b.start));
    if(events[0])return eventKind(events[0]);
    const all=(snapshot?.plans||[]).flatMap(p=>p.uncertain||p.queue!==snapshot.queue||snapshot.feedFailed||!fresh(p.checkedAt||snapshot.feedCheckedAt,now)?[]:p.events||[]).filter(e=>e.start>now).sort((a,b)=>a.start-b.start);
    return all[0]?.category;
  }
  const events=dayState(snapshot,date,now).events;
  const category=['emergency','planned','hourly'].find(k=>events.some(e=>e.category===k));
  return eventKind(events.find(e=>e.category===category));
}
export const categoryText=k=>({hourly:'Погодинне відключення',planned:'Планові роботи',unplanned:'Позапланове відключення',emergency:'Аварійне відключення'})[k]||'';
export function legend(style,category,full=false) {
  const color=`var(--${category||'hourly'})`,on=powerIcon(false,false,style),off=powerIcon(true,false,style);
  if(!full)return `<div class="short-legend" aria-label="Умовні позначення"><span><i class="legend-on">${on}</i>Світло є</span><span style="--sample-color:${color}"><i class="legend-off">${off}</i>Світла немає</span><span><i class="current-sample" aria-hidden="true"></i>Поточна година</span></div>`;
  return `<section class="full-legend" aria-label="Умовні позначення"><h2>Умовні позначення</h2>${['hourly','planned','unplanned','emergency'].map(k=>`<p><i class="legend-off" style="--sample-color:var(--${k})">${off}</i><span>— ${categoryText(k)}</span></p>`).join('')}<p><i class="half-sample" style="--sample-color:${color}" aria-hidden="true">${off}</i><span>— 30 хв без світла</span></p></section>`;
}
export function appearance(state) {
  const choice=(key,value,label,body,selected)=>`<button class="appearance-choice" data-look="${key}" data-value="${value}" aria-label="${label}" aria-pressed="${selected}">${body}</button>`;
  const row=(label,body)=>`<div class="appearance-row"><span class="appearance-label">${label}</span><div class="appearance-pair" role="group" aria-label="${label}">${body}</div></div>`;
  return `<section class="card appearance"><h2>Вигляд</h2>${row('Тема',choice('theme','dark','Темна тема',themeIcon(false)+'<span>Темна</span>',state.theme==='dark')+choice('theme','light','Світла тема',themeIcon(true)+'<span>Світла</span>',state.theme==='light'))}${row('Час',choice('range','false','Лише початок','<span class="time-example">13:00</span>',!state.rangeTiles)+choice('range','true','Початок і кінець','<span class="time-example">13:00<br>14:00</span>',state.rangeTiles))}${row('Значки',choice('icons','bolt','Блискавки',powerIcon(false,false,'bolt'),state.iconStyle==='bolt')+choice('icons','bulb','Лампочки',powerIcon(false,false,'bulb'),state.iconStyle==='bulb'))}</section>`;
}
export function notificationSettings(p,permission,push,{checking=false,busy=false,error=""}={}) {
  const prefs=preferences(p?.preferences),disabled=!p,leadDisabled=disabled||!prefs.reminder&&!prefs.restoration;
  const toggle=(key,label)=>`<label class="notification-toggle"><span>${label}</span><input role="switch" type="checkbox" data-pref="${key}" ${prefs[key]?'checked':''} ${disabled?'disabled':''}></label>`;
  const active=permission==='granted'&&push&&!checking;
  const status=checking?'Перевіряємо стан сповіщень':(error?(active?'Сповіщення увімкнено':'Сповіщення вимкнено')+' · '+error:null)|| (active?'Сповіщення увімкнено':permission==='denied'?'Сповіщення заблоковано в браузері':permission==='unsupported'?'Push у цьому браузері недоступний':'Сповіщення вимкнено');
  const bell=`<button class="notification-status ${active?'':'bell-off'}" data-notification-status data-full="${esc(status)}" aria-label="${esc(status)}" type="button"><svg class="notification-bell" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>${active?'':'<path d="m3 3 18 18"/>'}</svg></button>`;
  return `<section class="card notifications"><h2 class="notification-heading"><span>Сповіщення</span>${bell}</h2>${toggle('reminder','Перед відключенням')}${toggle('restoration','Перед очікуваним відновленням')}<div class="reminder-setting"><div class="reminder-copy"><label class="reminder-label" for="lead">Нагадувати за</label>${leadDisabled?'<small id="lead-help">Увімкніть нагадування, щоб вибрати час</small>':''}</div><select id="lead" ${leadDisabled?'disabled aria-describedby="lead-help"':''}>${[5,15,30,60].map(n=>`<option value="${n}" ${prefs.lead===n?'selected':''}>${n} хв</option>`).join('')}</select></div><hr>${toggle('publication','Графік на завтра')}${toggle('change','Зміни графіка')}${toggle('emergency','Аварії за адресою')}<div class="stack"><button data-action="push" ${disabled||busy?'disabled':''}>${busy?'Зачекайте…':(push?'Вимкнути':'Увімкнути')+' push-сповіщення'}</button></div><p class="install-note">На iPhone сповіщення доступні з iOS 16.4 після додавання на Початковий екран. Дозвіл запитується лише після натискання кнопки. Час доставки залежить від системи.</p></section>`;
}

export function fitPairs(root=document) {
  const rows=[...root.querySelectorAll('.fit-pair')], canvas=document.createElement('canvas').getContext('2d');
  const update=()=>{
    const scale=parseFloat(getComputedStyle(document.documentElement).fontSize)/16;
    rows.forEach(row=>{
      row.classList.remove('vertical');
      const nodes=[...row.children],desired=14*scale,min=12*scale;
      const fits=size=>nodes.every(n=>{const s=getComputedStyle(n);canvas.font=`${s.fontWeight} ${size}px ${s.fontFamily}`;return canvas.measureText(n.textContent).width+parseFloat(s.paddingLeft)+parseFloat(s.paddingRight)+2<=n.clientWidth;});
      if(scale>=1.4||!fits(min))row.classList.add('vertical');
      let size=desired;while(size>min&&!fits(size))size-=.25;
      nodes.forEach(n=>n.style.fontSize=size+'px');
    });
    root.querySelectorAll('.short-legend').forEach(el=>{
      el.style.setProperty('--legend-icon',(scale>1.5?18:16)+'px');
    });
    root.querySelectorAll('.appearance').forEach(el=>el.classList.toggle('large-text',scale>=1.4));
    root.querySelectorAll('.message').forEach(el=>el.classList.toggle('large-text',scale>=1.4));
    root.querySelectorAll('.notification-heading').forEach(heading=>{
      const text=heading.querySelector('span'),style=getComputedStyle(heading),available=heading.clientWidth-48;
      let size=20*scale;
      const width=()=>{canvas.font=`${style.fontWeight} ${size}px ${style.fontFamily}`;return canvas.measureText(text.textContent).width;};
      // Retain a whole heading at large text sizes, with a 1rem scaled minimum.
      while(size>16*scale&&width()>available)size-=.25;
      heading.style.fontSize=size+'px';
    });
  };
  let raf;const schedule=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(update);};
  const observer=new ResizeObserver(schedule);rows.forEach(r=>observer.observe(r));observer.observe(document.documentElement);
  document.fonts?.ready.then(schedule);update();
  return ()=>{observer.disconnect();cancelAnimationFrame(raf);};
}
