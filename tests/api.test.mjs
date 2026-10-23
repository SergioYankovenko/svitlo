import test from 'node:test';
import assert from 'node:assert/strict';
import {post} from '../app/api.js';
test('network failure is localized without falsely diagnosing no internet',async()=>{await assert.rejects(()=>post('https://test',{},async()=>{throw new TypeError('Failed to fetch')}),e=>e.message==='Оновлення тимчасово недоступне. Показуємо збережені дані.');});
test('non-JSON service outage is localized',async()=>{await assert.rejects(()=>post('https://test',{},async()=>new Response('<h1>Unavailable</h1>',{status:503})),/Оновлення тимчасово недоступне/);});
test('server validation error is retained',async()=>{await assert.rejects(()=>post('https://test',{},async()=>Response.json({error:'Підтвердьте адресу'},{status:400})),/Підтвердьте адресу/);});
