import test from 'node:test';import assert from 'node:assert/strict';import {subscribeWithTimeout} from '../pwa/live-push.js';
test('browser push registration timeout settles UI and handles a late real subscription separately',async()=>{
 let resolve,late=0;const pending=new Promise(r=>resolve=r);
 await assert.rejects(()=>subscribeWithTimeout({subscribe:()=>pending},{},{timeout:2,onLate:()=>late++}),/Не вдалося підключити сповіщення/);
 assert.equal(late,0);resolve({});await new Promise(r=>setTimeout(r,5));assert.equal(late,1);
});
test('normal browser subscription and rejection preserve actual outcomes without a late callback',async()=>{
 const value={endpoint:'test'},options={userVisibleOnly:true};let late=0;
 assert.equal(await subscribeWithTimeout({subscribe:o=>{assert.equal(o,options);return value;}},options,{timeout:100,onLate:()=>late++}),value);
 await assert.rejects(()=>subscribeWithTimeout({subscribe:()=>Promise.reject(Error('denied'))},options,{timeout:100}),/denied/);assert.equal(late,0);
});
