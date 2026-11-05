import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../pwa/sensor-scanner.js',import.meta.url),'utf8');
const valid=JSON.stringify({version:1,kind:'phone_owner',sensorId:'11111111-1111-4111-8111-111111111111',proof:'sp_'+'a'.repeat(43)});
class Node extends EventTarget {
 constructor(){super();this.hidden=false;this.value='';this.dataset={};this.isConnected=true;this.clientWidth=300;this.clientHeight=200;this.attrs={};}
 querySelector(){return this.path;}
 setAttribute(k,v){this.attrs[k]=v;}toggleAttribute(k,v){if(v)this.attrs[k]='';else delete this.attrs[k];}
 focus(){}async play(){}getContext(){return{drawImage(){},getImageData(){return{data:new Uint8ClampedArray(16),width:2,height:2};}};}
}
function setup(media,decoded){
 const nodes=Object.fromEntries(['video','[data-scan-message]','#sensor-code','[data-scan-manual]','[data-scan-enter]','[data-scan-camera]','[data-scan-corners]','[data-camera-unavailable]'].map(k=>[k,new Node()]));
 nodes['[data-scan-manual]'].hidden=true;nodes['[data-scan-enter]'].hidden=true;nodes['[data-scan-corners]'].path=new Node();
 nodes.video.readyState=2;nodes.video.videoWidth=640;nodes.video.videoHeight=480;
 const root=new Node();root.querySelector=k=>nodes[k];
 const document=new Node();document.createElement=()=>new Node();
 const window=new Node();Object.assign(window,{isSecureContext:true,jsQR:decoded||(()=>null)});
 let id=0;const timers=new Map();
 vm.runInNewContext(source,{window,document,navigator:{mediaDevices:media?{getUserMedia:media}:undefined},AbortController,queueMicrotask,setTimeout:f=>{timers.set(++id,f);return id;},clearTimeout:i=>timers.delete(i),Uint8ClampedArray});
 return{scanner:window.SvitloSensorScanner,root,nodes,document,timers};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('cover projection crops landscape and portrait source to the visible preview',()=>{
 const {scanner}=setup();
 assert.deepEqual(JSON.parse(JSON.stringify(scanner.crop(1280,720,300,200))),{x:100,y:0,width:1080,height:720});
 const p=scanner.crop(720,1280,300,200);assert.equal(p.x,0);assert.equal(p.width,720);assert.equal(p.height,480);assert.equal(p.y,400);
});
test('detected quadrilateral creates four rotated corner marks instead of a static rectangle',()=>{
 const {scanner}=setup(),location={topLeftCorner:{x:20,y:10},topRightCorner:{x:90,y:30},bottomRightCorner:{x:75,y:90},bottomLeftCorner:{x:5,y:70}};
 const d=scanner.cornerPath(location,100,100);assert.equal((d.match(/M/g)||[]).length,4);
 for(const point of ['20.000,10.000','90.000,30.000','75.000,90.000','5.000,70.000'])assert.ok(d.includes(point));
 assert.equal(scanner.cornerPath({},100,100),'');
});
test('no camera reveals only manual fallback and a complete valid manual code is accepted once',async()=>{
 const {scanner,root,nodes}=setup();const accepted=[];scanner.mount(root,{onCode:x=>accepted.push(x)});await flush();
 assert.equal(root.dataset.scanState,'unavailable');assert.equal(nodes['[data-scan-enter]'].hidden,false);
 nodes['[data-scan-enter]'].dispatchEvent(new Event('click'));
 assert.equal(nodes['[data-scan-manual]'].hidden,false);
 const input=nodes['#sensor-code'];input.value='wrong';input.dispatchEvent(new Event('input'));await flush();assert.equal(accepted.length,0);
 input.value=valid;input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('input'));await flush();assert.deepEqual(accepted,[valid]);scanner.dispose();
});
test('closing before camera permission resolves stops the late stream and never accepts a code',async()=>{
 let resolve,stopped=0;const media=()=>new Promise(r=>resolve=r),{scanner,root}=setup(media);let accepted=0;
 scanner.mount(root,{onCode:()=>accepted++});scanner.dispose();
 resolve({getTracks:()=>[{stop:()=>stopped++}],getVideoTracks:()=>[]});await flush();
 assert.equal(stopped,1);assert.equal(accepted,0);
});
test('a valid camera frame auto-verifies once and releases the camera',async()=>{
 let stopped=0;const track=new Node();track.stop=()=>stopped++;
 const media=async()=>({getTracks:()=>[track],getVideoTracks:()=>[track]});
 const location={topLeftCorner:{x:0,y:0},topRightCorner:{x:1,y:0},bottomRightCorner:{x:1,y:1},bottomLeftCorner:{x:0,y:1}};
 const {scanner,root,nodes,timers}=setup(media,()=>({data:valid,location})),accepted=[];
 scanner.mount(root,{onCode:x=>accepted.push(x)});await flush();
 assert.deepEqual(accepted,[valid]);assert.equal(stopped,1);assert.equal(timers.size,0);assert.equal(nodes['[data-scan-corners]'].dataset.tracking,'true');scanner.dispose();
});
test('unrelated camera QR keeps scanning and exposes manual entry, without accepting it',async()=>{
 let stopped=0;const track=new Node();track.stop=()=>stopped++;
 const location={topLeftCorner:{x:0,y:0},topRightCorner:{x:1,y:0},bottomRightCorner:{x:1,y:1},bottomLeftCorner:{x:0,y:1}};
 const {scanner,root,nodes,timers}=setup(async()=>({getTracks:()=>[track],getVideoTracks:()=>[track]}),()=>({data:'https://example.invalid',location}));
 let accepted=0;scanner.mount(root,{onCode:()=>accepted++});await flush();
 assert.equal(accepted,0);assert.equal(root.dataset.scanState,'invalid');assert.equal(nodes['[data-scan-enter]'].hidden,false);assert.equal(timers.size,1);assert.equal(stopped,0);scanner.dispose();assert.equal(stopped,1);
});

