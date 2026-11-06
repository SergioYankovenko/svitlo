// Server boundary only: Ajv is deliberately absent from the Android/PWA bundle.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {readFileSync} from 'node:fs';
import {validUniversal} from '../../app/lib/universal-contract.js';
const ajv=addFormats(new Ajv2020({strict:true,allErrors:false}));
const compile=name=>ajv.compile(JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8')));
const resolution=compile('./resolution.schema.json'),snapshot=compile('./snapshot.schema.json');
export function validResolution(value){
 return resolution(value)&&new Set(value.lines.map(l=>l.key)).size===value.lines.length;
}
export function validSnapshot(value,entity){
 return snapshot(value)&&validUniversal(value)&&(!entity||value.addressId===entity.id&&value.operatorId===entity.operator_id);
}
