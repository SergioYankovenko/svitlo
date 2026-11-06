// Only trusted composition code registers factories. Source configuration can
// select a known key, never an import path or arbitrary executable module.
export class AdapterRegistry {
 #definitions=new Map();
 register({key,operatorIds=null,testOnly=false,supports=()=>true,create}){
  if(typeof key!=='string'||!key||this.#definitions.has(key)||typeof create!=='function'||typeof supports!=='function'||
   operatorIds!==null&&(!Array.isArray(operatorIds)||!operatorIds.length||operatorIds.some(id=>typeof id!=='string'||!id)))throw Error('invalid_adapter_registration');
  this.#definitions.set(key,{operatorIds:operatorIds&&new Set(operatorIds),testOnly,supports,create});return this;
 }
 for(operator,context){
  const d=this.#definitions.get(operator?.adapter_key);
  if(!d||d.testOnly&&operator.is_test!==true||d.operatorIds&&!d.operatorIds.has(operator.id)||!d.supports(operator,context))return null;
  const adapter=d.create(context,operator);
  if(!adapter||typeof adapter.resolve!=='function'||typeof adapter.snapshot!=='function')throw Error('invalid_adapter_port');
  return adapter;
 }
}
