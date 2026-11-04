'use strict';
// Keep the prototype inside the actually visible area; OS keyboards need not resize dvh.
(() => {
  const mobile=window.matchMedia('(max-width:760px), (max-width:1000px) and (max-height:500px)');
  const root=document.documentElement;
  let largestHeight=window.innerHeight,lastWidth=window.innerWidth,keyboardOpen=false,frame=0,align=false,safeTop=0,freshFocus=false,lastHeight=window.innerHeight,lastVisibleWidth=window.innerWidth;
  const editable=element=>element instanceof HTMLInputElement&&!['checkbox','radio','button','range','color'].includes(element.type)||element instanceof HTMLTextAreaElement;
  function welcomeLayout(){
    const city=document.getElementById('onboard-city'),intro=document.getElementById('onboard-city-intro');
    if(city){if(intro)city.setAttribute('aria-describedby',intro.id);else city.removeAttribute('aria-describedby');}
    const show=keyboardOpen&&city&&intro&&(city.value.trim().length<2||document.querySelector('.lookup-pending'));
    document.body.classList.toggle('keyboard-welcome',!!show);
    document.body.classList.remove('keyboard-welcome-compact');
    if(!show)return;
    const greeting=intro.closest('.onboard-greeting'),card=city.closest('.onboard-card'),page=document.getElementById('page-scroll');
    if(!greeting||!card||!page)return;
    // Keep the complete greeting when both it and the field fit. Otherwise retain its portrait beside the field.
    if(card.getBoundingClientRect().bottom-greeting.getBoundingClientRect().top>page.clientHeight-24){
      document.body.classList.add('keyboard-welcome-compact');
      const style=getComputedStyle(card);
      greeting.style.setProperty('--welcome-portrait-top',((parseFloat(style.paddingTop)||0)+(parseFloat(style.borderTopWidth)||0))+'px');
      greeting.style.setProperty('--welcome-portrait-left',((parseFloat(style.paddingLeft)||0)+(parseFloat(style.borderLeftWidth)||0))+'px');
    }
  }
  function alignField(){
    const input=document.activeElement,app=document.getElementById('app'),page=document.getElementById('page-scroll');
    if(!keyboardOpen||!editable(input)||!app?.contains(input)||!page)return;
    const group=input.closest('.onboard-search-group');
    if(group){
      const card=group.closest('.onboard-card');
      const welcome=document.body.classList.contains('keyboard-welcome')&&!document.body.classList.contains('keyboard-welcome-compact');
      const anchor=welcome?group.closest('.onboard-address-flow'):(card||group);
      card?.classList.remove('keyboard-small');
      const results=group.querySelector('.onboard-results');
      // Keep the rounded card edge visible. Aligning the field alone scrolls its card above the viewport.
      for(let pass=0;pass<2;pass++){
        const top=Math.max(0,page.scrollTop+anchor.getBoundingClientRect().top-page.getBoundingClientRect().top-12);
        if(Math.abs(page.scrollTop-top)>1)page.scrollTo({top,behavior:'instant'});
        if(results){
          const style=getComputedStyle(anchor),bottom=(parseFloat(style.paddingBottom)||0)+(parseFloat(style.borderBottomWidth)||0)+12;
          const available=page.getBoundingClientRect().bottom-results.getBoundingClientRect().top-bottom;
          if(available<48&&card&&!card.classList.contains('keyboard-small')){card.classList.add('keyboard-small');continue;}
          results.style.setProperty('--picker-space',Math.max(48,Math.floor(available))+'px');
        }
      }
    }else if(input.id==='onboard-name'){
      const card=input.closest('.onboard-card')||input;
      card.classList.remove('keyboard-small');
      if(card.getBoundingClientRect().height>page.clientHeight-24)card.classList.add('keyboard-small');
      const clearance=Math.max(0,Math.min(12,(page.clientHeight-card.getBoundingClientRect().height)/2));
      const top=Math.max(0,page.scrollTop+card.getBoundingClientRect().top-page.getBoundingClientRect().top-clearance);
      if(Math.abs(page.scrollTop-top)>1)page.scrollTo({top,behavior:'instant'});
    }
  }
  function update(){
    frame=0;
    root.style.setProperty('--prototype-system-background',document.querySelector('meta[name=theme-color]')?.content||'#14251E');
    if(!mobile.matches){
      largestHeight=window.innerHeight;lastHeight=window.innerHeight;lastWidth=window.innerWidth;lastVisibleWidth=window.innerWidth;
      keyboardOpen=false;document.body.classList.remove('keyboard-open','keyboard-welcome','keyboard-welcome-compact');
      root.style.removeProperty('--prototype-visible-height');root.style.removeProperty('--prototype-visible-top');root.style.removeProperty('--prototype-held-top');safeTop=0;align=false;freshFocus=false;window.SvitloLookupUI?.sync();return;
    }
    const viewport=window.visualViewport,zoomed=viewport&&Math.abs(viewport.scale-1)>.05;
    const height=zoomed?window.innerHeight:(viewport?.height||window.innerHeight);
    const width=window.innerWidth;
    const stationary=Math.abs(height-lastHeight)<1&&Math.abs(width-lastVisibleWidth)<1;
    if(Math.abs(width-lastWidth)>80){largestHeight=height;lastHeight=height;keyboardOpen=false;lastWidth=width;if(!keyboardOpen){safeTop=0;root.style.removeProperty('--prototype-held-top');}}
    // Some browsers reduce dynamic insets with the IME. Keep the last unobscured top reserve until it closes.
    const shell=document.querySelector('.preview-stage');
    if(!keyboardOpen&&shell)safeTop=parseFloat(getComputedStyle(shell).paddingTop)||0;
    largestHeight=Math.max(largestHeight,height,window.innerHeight);
    const active=document.activeElement,app=document.getElementById('app'),editing=editable(active)&&app?.contains(active);
    // A near-full-height restoration also closes the IME after a small width change / browser chrome resize.
    const restored=keyboardOpen&&height-lastHeight>120&&height>=largestHeight-120;
    if(restored)largestHeight=height;
    const reduced=largestHeight-height>(keyboardOpen?40:120);
    // A result gets focus before its click. Do not move it on focusout while the viewport is unchanged.
    keyboardOpen=!zoomed&&!restored&&((reduced&&(editing||keyboardOpen))||(freshFocus&&editing&&height<480)||(keyboardOpen&&stationary&&app?.classList.contains('in-onboarding')));
    if(!editing&&!app?.classList.contains('in-onboarding'))keyboardOpen=false;
    if(!editing&&!reduced)keyboardOpen=false;
    root.style.setProperty('--prototype-visible-height',height+'px');
    root.style.setProperty('--prototype-visible-top',zoomed?'0px':(viewport?.offsetTop||0)+'px');
    if(keyboardOpen)root.style.setProperty('--prototype-held-top',safeTop+'px');else root.style.removeProperty('--prototype-held-top');
    document.body.classList.toggle('keyboard-open',!!keyboardOpen);
    welcomeLayout();
    window.SvitloLookupUI?.sync();
    if(keyboardOpen&&align)alignField();
    if(!keyboardOpen){
      document.querySelectorAll('.onboard-results').forEach(el=>el.style.removeProperty('--picker-space'));
      document.querySelectorAll('.keyboard-small').forEach(el=>el.classList.remove('keyboard-small'));
    }
    align=false;freshFocus=false;lastHeight=height;lastVisibleWidth=width;
  }
  function refresh(shouldAlign=false){align=align||shouldAlign;if(!frame)frame=requestAnimationFrame(update);}
  window.addEventListener('resize',()=>refresh(true));
  window.visualViewport?.addEventListener('resize',()=>refresh(true));
  window.visualViewport?.addEventListener('scroll',()=>refresh(true));
  document.addEventListener('focusin',event=>{freshFocus=editable(event.target);refresh(true);});
  document.addEventListener('focusout',()=>refresh());
  document.addEventListener('input',event=>{if(editable(event.target))refresh(true);});
  document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.id==='onboard-name'){event.preventDefault();event.target.blur();}});
  window.SvitloViewport={refresh,isMobile:()=>mobile.matches};refresh();
})();
