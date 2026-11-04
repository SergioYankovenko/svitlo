'use strict';
// Move one live status between the mascot bubble and field; never clone its explanation.
(() => {
  function sync(){
    const confirmation=document.querySelector('.onboard-confirmation-address'),addressInline=document.querySelector('.confirmed-inline-host'),addressSpeech=document.querySelector('.confirmed-speech-host');
    if(confirmation&&addressInline){
      const showInSpeech=addressSpeech&&!document.body.classList.contains('keyboard-open');
      const destination=showInSpeech?addressSpeech:addressInline;
      if(confirmation.parentElement!==destination)destination.append(confirmation);
    }
    const inline=document.querySelector('.lookup-inline-host'),message=document.querySelector('.lookup-message');
    if(!inline||!message)return;
    const speech=document.querySelector('.lookup-speech-host'),greeting=speech?.closest('.onboard-greeting');
    const visible=speech&&greeting&&!document.body.classList.contains('keyboard-open')&&getComputedStyle(greeting).display!=='none';
    const destination=visible?speech:inline;
    if(message.parentElement!==destination)destination.append(message);
    inline.closest('.lookup-state')?.classList.toggle('lookup-in-speech',!!visible);
  }
  window.SvitloLookupUI={sync};
})();
