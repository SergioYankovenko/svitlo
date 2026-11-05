import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto as crypto} from 'node:crypto';
const source=await readFile(new URL('../pwa/live-sensors.js',import.meta.url),'utf8');
const qr=JSON.stringify({version:1,kind:'phone_owner',sensorId:'11111111-1111-4111-8111-111111111111',proof:'sp_'+'a'.repeat(43)});
function setup(bound=false){
 let active='a',addresses=[{id:'a',city:'Місто A',street:'Вулиця A'},{id:'b',city:'Місто B',street:'Вулиця B'}],onCode;
 const dialogs=[],requests=[],toasts=[],root={isConnected:true,querySelector:()=>({}),setAttribute(){}};
 const live={sensors:()=>bound?[{sensorId:'s',bindingEpoch:1,readerProfileId:'a'}]:[],sensor:async(action,data)=>{requests.push({action,data});return{};},sync:async()=>{},refreshSensors:async()=>{}};
 const window={SvitloLive:live,SvitloSensorModel:{},SvitloNativeUI:{icon:()=>''},SvitloSensorScanner:{html:()=>'',mount:(_,options)=>onCode=options.onCode}};
 const document={getElementById:()=>({addEventListener(){}}),querySelector:()=>root};
 vm.runInNewContext(source,{window,document,localStorage:{getItem:()=>null},crypto});
 const ctx={esc:x=>x,address:()=>addresses.find(a=>a.id===active),addresses:()=>addresses,button:()=>'',dialog:(title)=>dialogs.push(title),close:()=>{root.isConnected=false;},toast:t=>toasts.push(t),render(){}};
 const ui=window.SvitloLiveSensors.create(ctx);
 return{ui,dialogs,requests,toasts,scan:()=>onCode?.(qr),switchTo:id=>active=id,remove:()=>addresses=addresses.filter(a=>a.id!=='a'),close:()=>root.isConnected=false};
}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
test('connect uses the active address, not another free one',async()=>{
 const s=setup(true);s.ui.handle('sensor-connect',{});await flush();
 assert.equal(s.dialogs.length,0);assert.equal(s.requests.length,0);assert.ok(s.toasts[0].includes('вже підключено'));
});
test('switching or deleting the active target before decode never selects a fallback',async()=>{
 for(const change of ['switch','delete']){
  const s=setup();s.ui.handle('sensor-connect',{});if(change==='switch')s.switchTo('b');else{s.remove();s.switchTo('b');}s.scan();await flush();
  assert.deepEqual(s.dialogs,['Підключити датчик']);assert.equal(s.requests.length,0);
 }
});
test('closed scanner ignores late accepted code',async()=>{
 const s=setup();s.ui.handle('sensor-connect',{});s.close();s.scan();await flush();
 assert.deepEqual(s.dialogs,['Підключити датчик']);assert.equal(s.requests.length,0);
});
test('target is revalidated again before the authoritative connect API',async()=>{
 const s=setup();s.ui.handle('sensor-connect',{});s.scan();assert.equal(s.dialogs.at(-1),'Підтвердити точку');assert.equal(s.requests.length,0);
 s.switchTo('b');s.ui.handle('sensor-confirm',{});await flush();assert.equal(s.requests.length,0);
});
test('explicit final confirmation sends the original active profile id',async()=>{
 const s=setup();s.ui.handle('sensor-connect',{});s.scan();s.ui.handle('sensor-confirm',{});await flush();
 assert.equal(s.requests.length,1);assert.equal(s.requests[0].action,'connect_qr');assert.equal(s.requests[0].data.profileId,'a');assert.equal(s.requests[0].data.qr.sensorId,JSON.parse(qr).sensorId);
});

