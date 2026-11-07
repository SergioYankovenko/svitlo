import {planWindows} from '../../app/lib/planning.js';
export function viewport(d){const b=d?.bounds;if(!b||Object.keys(b).sort().join()!=='east,north,south,west'||Object.values(b).some(v=>!Number.isFinite(v))||b.west<22||b.east>41||b.south<44||b.north>53||b.west>=b.east||b.south>=b.north||(b.east-b.west)*(b.north-b.south)>4)throw Object.assign(Error('Збільш карту для перегляду станцій'),{status:400,code:'invalid_charging_viewport'});return b;}
export function chargingForecast({binding,snapshot,date,now=Date.now(),stationId}){
 const unknown=reason=>({schemaVersion:1,stationId,state:'unknown',reason,guaranteed:false,gridPlan:null});
 if(!binding?.reviewed||!binding.addressId||!binding.lineId||!binding.proof||!Number.isFinite(binding.validFrom)||!Number.isFinite(binding.validUntil)||binding.validFrom>now||binding.validUntil<=now)return unknown('electrical_binding_unverified');
 if(snapshot?.addressId!==binding.addressId)return unknown('electrical_binding_mismatch');
 const plan=planWindows(snapshot,binding.lineId,date,{now,policy:'conservative'});if(plan.state!=='ready')return unknown(plan.reason);
 return {schemaVersion:1,stationId,state:'conditional',reason:binding.backupPower==='yes'?'backup_power_reported':'published_grid_plan',guaranteed:false,stationAvailability:'unknown',backupPower:binding.backupPower||'unknown',gridPlan:{date,revision:snapshot.revision,lineId:binding.lineId,policy:plan.policy,validUntil:Math.min(plan.validUntil,binding.validUntil),windows:plan.windows,outages:plan.outages},sourceProof:binding.proof};
}
export class ChargingService {
 constructor({bridge,schedules}){Object.assign(this,{bridge,schedules});}
 async capabilities(){return (await this.bridge.query('select svitlo_charging.capabilities() value')).rows[0].value;}
 async handle(d){if(d?.schemaVersion!==1||!['viewport','forecast'].includes(d.action))throw Object.assign(Error('invalid_charging_request'),{status:400});const c=await this.capabilities();if(!c.enabled)throw Object.assign(Error('charging_not_enabled'),{status:503});
  if(d.action==='viewport'){const b=viewport(d);return {schemaVersion:1,...(await this.bridge.query('select svitlo_charging.viewport($1,$2,$3,$4) value',[b.west,b.south,b.east,b.north])).rows[0].value};}
  if(typeof d.stationId!=='string'||!/^ocm:[1-9][0-9]{0,11}$/.test(d.stationId)||!/^\d{4}-\d{2}-\d{2}$/.test(d.date||''))throw Object.assign(Error('invalid_charging_forecast'),{status:400});
  const binding=(await this.bridge.query('select svitlo_charging.binding($1) value',[d.stationId])).rows[0].value;
  if(!binding?.reviewed)return chargingForecast({binding,stationId:d.stationId});
  const snapshot=await this.schedules.snapshot(binding.addressId,{fromDate:d.date,toDate:d.date});return chargingForecast({binding,snapshot,date:d.date,stationId:d.stationId});
 }
}
