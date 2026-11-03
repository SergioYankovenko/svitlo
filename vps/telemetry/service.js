import {RequestIds,diagnosticPacket,problem} from './validation.js';
const allowed={operation:['catalog_lookup','profile_write','diagnostic_report'],field:['city','street','house','name','request'],reason:['schema','size','control','operation','owner','rate'],confidence:['schema_violation','heuristic']};
export class SecuritySink {
 constructor(write,{limit=32}={}){Object.assign(this,{write,limit});this.queue=[];this.running=null;this.failed=0;this.dropped=0;}
 emit(input){
  if(!Object.entries(allowed).every(([k,values])=>values.includes(input[k])))return false;
  if(this.queue.length>=this.limit){this.dropped++;return false;}
  const p=Object.fromEntries(Object.keys(allowed).map(k=>[k,input[k]]));p.source='api';
  if(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.correlationId||''))p.correlationId=input.correlationId;
  this.queue.push(p);if(!this.running)this.running=this.drain();return true;
 }
 async drain(){await Promise.resolve();while(this.queue.length){try{await this.write(this.queue.shift());}catch{this.failed++;}}this.running=null;}
 async flush(){while(this.running)await this.running;}
}
export class Telemetry {
 constructor(bridge,secret){this.db=bridge;this.requestIds=new RequestIds(secret);this.sink=new SecuritySink(p=>this.db.query('select svitlo_telemetry.record_security($1::jsonb)',[JSON.stringify(p)]));}
 async submit(owner,input,consent){
  const p=diagnosticPacket(input,{owner,consent,requestIds:this.requestIds});
  const r=(await this.db.query('select svitlo_telemetry.submit_report($1::jsonb) result',[JSON.stringify(p)])).rows[0].result;
  if(r.status==='quota'||r.status==='capacity')throw Object.assign(problem(429,'diagnostic_limit','rate'),{retryAfter:r.retryAfter});
  if(r.status==='conflict')throw problem(409,'report_id_conflict');if(r.status==='invalid')throw problem(400,'invalid_report');
  if(!['created','duplicate'].includes(r.status))throw problem(503,'report_unavailable');
  const {status,...receipt}=r;return {status:status==='created'?201:200,receipt};
 }
 reject({path,status,reason,correlationId,field='request'}){
  if(reason==='upstream'||![400,401,403,405,413,415,429].includes(status))return;
  const operation=path?.includes('diagnostic-reports')?'diagnostic_report':path==='/api'?'profile_write':'catalog_lookup';
  this.sink.emit({operation,field,reason:reason||({401:'owner',403:'owner',405:'operation',413:'size',429:'rate'}[status]||'schema'),confidence:'schema_violation',correlationId});
 }
 async forget(){await this.db.query('select svitlo_telemetry.forget_reports()');}
}
