import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const window={};
vm.runInNewContext(await readFile(new URL('../pwa/live-sensors.js',import.meta.url),'utf8'),{window});
const available=window.SvitloLiveSensors.forecastAvailable;

test('missing, unavailable or unknown-only prediction never creates a forecast panel',()=>{
 for(const data of [null,{}, {reason:'not_implemented'},{available:false,segments:[{start:0,end:60,state:'on'}]},{available:true,segments:[]},{available:true,segments:[{start:0,end:1440,state:'unknown'}]}])assert.equal(available(data),false);
});
test('a formed prediction requires finite positive intervals with at least one known predicted state',()=>{
 for(const state of ['on','off'])assert.equal(available({available:true,segments:[{start:0,end:30,state},{start:30,end:1440,state:'unknown'}]}),true);
 for(const segment of [{start:-1,end:60,state:'on'},{start:30,end:30,state:'off'},{start:0,end:Infinity,state:'on'},{start:0,end:60,state:'clear'},null])assert.equal(available({available:true,segments:[segment]}),false);
});
