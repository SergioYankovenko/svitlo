import test from 'node:test';import assert from 'node:assert/strict';import {houseKey,sameHouse,canonicalIdentityPolicy} from './identity.js';
test('house identity preserves literal corpus/slash/space/script distinctions and administrative scope is independent',()=>{
 assert.ok(sameHouse('10А','10а'));assert.ok(sameHouse(' 10а ','10а'));
 for(const [a,b] of [['10/1','101'],['10-а','10а'],['10 а','10а'],['10а','10a'],['10 корпус 1','10 корпус 2'],['12','21']])assert.equal(sameHouse(a,b),false);
 for(const value of ['',null,'10\n1','x'.repeat(121)])assert.equal(houseKey(value),null);
 assert.equal(canonicalIdentityPolicy.homeKey,'canonicalAddressId');assert.equal(canonicalIdentityPolicy.geographyDefinesElectricalGroup,false);
});
