"use strict";
// Agreed LIVE43–60 presentation. This module never grants rights or changes evidence.
window.SvitloNextUI = (() => {
  const leads=[5,15,30,60];
  function closeReminder(focus=false){
    const root=document.querySelector('.reminder-row'),button=root?.querySelector('[data-action="reminder"]');
    root?.querySelector('.reminder-dropdown')?.remove();button?.setAttribute('aria-expanded','false');
    if(focus)button?.focus({preventScroll:true});
  }
  function reminder(button,value){
    const root=button.closest('.reminder-row');if(!root||button.disabled)return;
    if(root.querySelector('.reminder-dropdown'))return closeReminder();
    button.setAttribute('aria-expanded','true');button.setAttribute('aria-haspopup','listbox');
    const menu=document.createElement('div');menu.className='reminder-dropdown';menu.setAttribute('role','listbox');menu.setAttribute('aria-label','Нагадувати за');
    menu.innerHTML=leads.map(m=>`<button type="button" role="option" class="dialog-action" data-action="set-reminder" data-minutes="${m}" aria-selected="${m===value}"><span>${m} хв</span><span aria-hidden="true">${m===value?'✓':''}</span></button>`).join('');
    root.append(menu);
    const boundary=button.closest('.page-scroll')?.getBoundingClientRect().bottom||innerHeight;
    if(menu.getBoundingClientRect().bottom>boundary-8&&button.getBoundingClientRect().top>menu.offsetHeight+8)menu.dataset.side='above';
    menu.querySelector('[aria-selected="true"]')?.focus({preventScroll:true});
  }
  document.addEventListener('pointerdown',e=>{if(!e.target.closest('.reminder-row'))closeReminder();});
  document.addEventListener('keydown',e=>{
    const row=e.target.closest('.reminder-row');if(!row)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeReminder(true);return;}
    const items=[...row.querySelectorAll('[role="option"]')],index=items.indexOf(e.target);
    if(index>=0&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
      e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:items.length-1))%items.length].focus();
    }
  });
  let foldId=0;
  function fold(title,content,open=false){
    const id='sensor-help-fold-'+(++foldId);
    return `<section class="sensor-help-fold"><button type="button" class="sensor-help-fold-toggle" data-help-fold="${id}" aria-expanded="${open}" aria-controls="${id}"><span>${title}</span><span class="sensor-help-chevron" aria-hidden="true">${window.SvitloNativeUI.icon('chevron')}</span></button><div class="sensor-help-fold-body" id="${id}" data-open="${open}" ${open?'':'inert aria-hidden="true"'}><div><div class="sensor-help-fold-copy">${content}</div></div></div></section>`;
  }
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-help-fold]');if(!b)return;
    const open=b.getAttribute('aria-expanded')!=='true',group=b.closest('.sensor-help-folds');
    for(const button of group.querySelectorAll('[data-help-fold]')){
      const expanded=button===b&&open,panel=document.getElementById(button.dataset.helpFold);
      button.setAttribute('aria-expanded',String(expanded));panel.dataset.open=String(expanded);panel.inert=!expanded;
      if(expanded)panel.removeAttribute('aria-hidden');else panel.setAttribute('aria-hidden','true');
    }
  });
  const routes={sensor:'/go/sensor',subscription:'/go/subscription',schedule:'/go/schedule-help'};
  function redirect(kind){const url=routes[kind];if(url)window.open(url,'_blank','noopener,noreferrer');}
  async function share(text){
    if(typeof navigator.share==='function'){
      try{await navigator.share({text});return 'shared';}catch(e){if(e.name==='AbortError')return 'cancelled';throw e;}
    }
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return 'copied';}
    throw Error('Не вдалося скопіювати текст. Спробуйте у браузері з підтримкою поширення.');
  }
  return {closeReminder,reminder,fold,redirect,share};
})();
