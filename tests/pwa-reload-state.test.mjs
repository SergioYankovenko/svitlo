import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberReloadView,takeReloadView} from '../pwa/reload-state.js';
function storage(){const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};}
test('worker reload restores only the same session view once, including options scroll and safe focus',()=>{
 const s=storage();assert.equal(rememberReloadView(s,'owner',{tab:'options',scroll:318,focusAction:'reminder'},100),true);
 assert.deepEqual(takeReloadView(s,'owner',150),{tab:'options',scroll:318,focusAction:'reminder'});assert.equal(takeReloadView(s,'owner',150),null);
});
test('another or lost owner, expired record and future clock cannot inherit an old view',()=>{
 for(const [owner,now] of [['other',150],[null,150],['owner',300101],['owner',99]]){const s=storage();rememberReloadView(s,'owner',{tab:'messages',scroll:1},100);assert.equal(takeReloadView(s,owner,now),null);}
});
test('storage failures do not prevent an update, and focus strings cannot inject a selector',()=>{
 const s=storage();rememberReloadView(s,'owner',{tab:'home',scroll:-10,focusAction:'x"] button'},100);assert.deepEqual(takeReloadView(s,'owner',101),{tab:'home',scroll:0,focusAction:null});
 const blocked=()=>{throw Error('storage blocked');};assert.equal(rememberReloadView(blocked,'owner',{tab:'options'},100),false);assert.equal(takeReloadView(blocked,'owner',100),null);
});
