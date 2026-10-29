const fields=new Set(['id','type','title','body','publishedAt','expiresAt','audience','targetVersionCode','action']);
const links=new Set(['https://www.svitlo.guru','https://www.svitlo.guru/','https://svitlo.guru','https://svitlo.guru/','https://sergioyankovenko.github.io/svitlo/']);
const need=(test)=>{if(!test)throw new Error('Invalid message contract');};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed)=>{need(object(v));need(Object.keys(v).every(k=>allowed.has(k)));};
const code=v=>Number.isSafeInteger(v)&&v>=1&&v<=2100000000;
const text=(v,max)=>typeof v==='string'&&v.length>=1&&v.length<=max&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
export function validatePublic(value){
  keys(value,new Set(['schema','packageId','generatedAt','messages']));
  need(value.schema===1&&value.packageId==='ua.svitlo.widget'&&Number.isFinite(Date.parse(value.generatedAt)));
  need(Array.isArray(value.messages)&&value.messages.length<=100);
  const ids=new Set();
  for(const m of value.messages){
    keys(m,fields);need(typeof m.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(m.id)&&!ids.has(m.id));ids.add(m.id);
    need(['app_update','maintenance','service'].includes(m.type)&&text(m.title,120)&&text(m.body,2000));
    need(Number.isFinite(Date.parse(m.publishedAt))&&Number.isFinite(Date.parse(m.expiresAt))&&Date.parse(m.expiresAt)>Date.parse(m.publishedAt));
    const a=m.audience;need(object(a));
    if(a.kind==='all')keys(a,new Set(['kind']));
    else {need(a.kind==='versions');keys(a,new Set(['kind','minVersionCode','maxVersionCode']));
      const lo=a.minVersionCode,hi=a.maxVersionCode;need(lo!=null||hi!=null);need(lo==null||code(lo));need(hi==null||code(hi));need(lo==null||hi==null||lo<=hi);}
    need(m.type==='app_update'?code(m.targetVersionCode):m.targetVersionCode==null);
    if(m.action!=null){keys(m.action,new Set(['kind','url']));need(m.action.kind==='open_url'&&links.has(m.action.url));}
    need(m.type!=='app_update'||m.action!=null);
  }
  need(new TextEncoder().encode(JSON.stringify(value)).length<=65536);
  return value;
}
