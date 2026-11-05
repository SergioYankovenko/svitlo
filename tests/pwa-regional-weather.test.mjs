import test from 'node:test';
import assert from 'node:assert/strict';
import {Source} from '../server/source.js';
import {SyncService} from '../server/sync.js';
const forecast={current:{temperature_2m:8,weather_code:3,is_day:1},hourly:{time:[Math.floor(Date.now()/1000)],temperature_2m:[8],weather_code:[3],is_day:[1]}};
test('Kyiv forecast uses Kyiv coordinates, not Cherkasy or a previous city',async()=>{
 const urls=[],s=new Source(async url=>{urls.push(new URL(url));return Response.json(forecast);});
 const w=await s.weather('м. Київ',{operatorId:'ua-kyiv-dtek'});
 assert.equal(w.city,'м. Київ');assert.equal(w.temperature,8);assert.equal(urls.length,1);
 assert.equal(urls[0].searchParams.get('latitude'),'50.4501');assert.equal(urls[0].searchParams.get('longitude'),'30.5234');
});
test('regional geocoding rejects same-name settlements outside the selected operator region',async()=>{
 const urls=[],s=new Source(async url=>{const u=new URL(url);urls.push(u);return Response.json(u.hostname.startsWith('geocoding')?{results:[{name:'Бровари',country_code:'UA',admin1:'Cherkasy Oblast',latitude:49,longitude:31},{name:'Бровари',country_code:'UA',admin1:'Kyiv Oblast',latitude:50.51,longitude:30.79}]}:forecast);});
 assert.equal((await s.weather('м. Бровари',{operatorId:'ua-kyiv-region-dtek'})).city,'м. Бровари');
 assert.equal(urls.at(-1).searchParams.get('latitude'),'50.51');
});
test('shared city cache keeps regional forecasts separate and coalesces same-city requests',async()=>{
 let calls=0;const service={db:{},now:()=>Date.now(),source:{weather:async(city,options)=>{calls++;return {city,operator:options.operatorId,checkedAt:Date.now()};}}},sync=new SyncService(service);
 const a={department:'universal:ua-kyiv-dtek',cityId:'kyiv',city:'м. Київ',operatorId:'ua-kyiv-dtek'},b={department:'3',cityId:'116',city:'м. Христинівка',operatorId:'ua-cherkasy'};
 const values=await Promise.all([sync.weatherFor(a),sync.weatherFor(a),sync.weatherFor(b)]);
 assert.equal(calls,2);assert.equal(values[0].operator,'ua-kyiv-dtek');assert.equal(values[2].city,b.city);
});
