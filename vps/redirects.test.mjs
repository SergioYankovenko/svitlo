import test from 'node:test';import assert from 'node:assert/strict';import {redirectTarget} from './redirects.js';
test('fixed redirect names accept configured HTTPS destinations and reject arbitrary URLs',()=>{
 assert.equal(redirectTarget('/go/sensor',{}),'https://www.svitlo.guru/');
 assert.equal(redirectTarget('/go/subscription',{SVITLO_SUBSCRIPTION_URL:'https://www.svitlo.guru/buy'}),'https://www.svitlo.guru/buy');
 for(const value of ['javascript:alert(1)','http://unsafe.test','https://user:pass@unsafe.test'])assert.equal(redirectTarget('/go/sensor',{SVITLO_SENSOR_INFO_URL:value}),'https://www.svitlo.guru');
 assert.equal(redirectTarget('/go/https://unsafe.test',{}),null);
});
