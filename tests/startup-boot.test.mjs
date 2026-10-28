import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
async function boot({controllerVersion,registerError=false}={}){
 const scripts=[],root={dataset:{}},meta={},app={textContent:'loading'};
 const document={currentScript:{dataset:{shell:'svitlo-pwa-new'},src:'https://local.test/app/boot-theme.js'},readyState:'complete',documentElement:root,querySelector:s=>s==='#app'?app:meta,createElement:()=>({}),body:{append:s=>scripts.push(s)}};
 class Channel{constructor(){this.port1={close(){}};this.port2={peer:this.port1};}}
 const serviceWorker={controller:controllerVersion?{postMessage(_message,ports){queueMicrotask(()=>ports[0].peer.onmessage({data:{cache:controllerVersion}}));}}:null,addEventListener(){},register:async()=>{if(registerError)throw Error('offline');return{addEventListener(){}};}};
 vm.runInNewContext(await readFile('app/boot-theme.js','utf8'),{document,navigator:{serviceWorker},localStorage:{getItem:()=>JSON.stringify('light')},URL,MessageChannel:Channel,setTimeout,clearTimeout});
 await new Promise(r=>setTimeout(r,10));return {scripts,root,meta,app};
}
test('bootstrap applies a saved light theme before main and starts core without a controlling SW',async()=>{
 const b=await boot();assert.equal(b.root.dataset.theme,'light');assert.equal(b.scripts.length,1);assert.equal(String(b.scripts[0].src),'https://local.test/app/main.js');
});
test('bootstrap starts core only for the same controlled shell version',async()=>{
 const b=await boot({controllerVersion:'svitlo-pwa-new'});assert.equal(b.scripts.length,1);
 for(const registerError of [false,true]){const old=await boot({controllerVersion:'svitlo-pwa-old',registerError});assert.equal(old.scripts.length,0);assert.match(old.app.textContent,/вікна/);}
});
