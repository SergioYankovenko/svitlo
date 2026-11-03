import pg from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';

export const ownerContext = new AsyncLocalStorage();
const ident = value => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw Error('Invalid SQL identifier');
  return '"'+value+'"';
};
pg.types.setTypeParser(20, value => {
  const n=Number(value); if(!Number.isSafeInteger(n))throw Error('Unsafe bigint'); return n;
});
export function pool(role='api', max=4) {
  const user='svitlo_stage_'+role;
  const p=new pg.Pool({host:process.env.PGHOST||'postgres',database:process.env.PGDATABASE||'svitlo_staging',user,
    password:readFileSync('/run/secrets/'+role+'_password','utf8').trim(),max,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,
    application_name:'svitlo-stage-'+role,options:'-c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000 -c lock_timeout=5000'});
  p.on('error',e=>console.error(JSON.stringify({event:'db_idle_error',code:e.code||'unknown'})));
  return p;
}

// Server-internal compatibility adapter. No arbitrary SQL/table/RPC endpoint is exposed over HTTP.
export class PgBridge {
  constructor(pool){this.pool=pool;this.tables=new Map();this.functions=new Map();}
  async init(){
    const columns=await this.pool.query("select table_name,column_name,udt_name from information_schema.columns where table_schema='public' and table_name like 'svitlo_%'");
    for(const r of columns.rows){if(!this.tables.has(r.table_name))this.tables.set(r.table_name,new Map());this.tables.get(r.table_name).set(r.column_name,r.udt_name);}
    const funcs=await this.pool.query("select p.proname,p.proargnames,p.proargtypes::oid[] as types,p.proretset from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'svitlo_%'");
    for(const r of funcs.rows)this.functions.set(r.proname,r);
    return this;
  }
  async query(sql,values=[]){
    const c=await this.pool.connect();
    try{await c.query('begin');await c.query("select set_config('svitlo.owner_id',$1,true)",[ownerContext.getStore()||'']);
      const r=await c.query(sql,values);await c.query('commit');return r;
    }catch(e){await c.query('rollback').catch(()=>{});throw e;}finally{c.release();}
  }
  from(table){if(!this.tables.has(table))throw Error('Unknown table');return new Query(this,table);}
  async rpc(name,args={}){
    try{
      const f=this.functions.get(name);if(!f)throw Error('Unknown RPC');
      const names=f.proargnames||[],values=[];
      const sqlArgs=Object.entries(args).map(([key,value])=>{
        const i=names.indexOf(key);if(i<0||i>=f.types.length)throw Error('Unknown RPC argument');
        values.push([114,3802].includes(f.types[i])&&value!==null?JSON.stringify(value):value);
        return ident(key)+' => $'+values.length;
      });
      const r=await this.query(f.proretset?`select * from public.${ident(name)}(${sqlArgs})`:`select public.${ident(name)}(${sqlArgs}) as value`,values);
      return {data:f.proretset?r.rows:r.rows[0]?.value,error:null};
    }catch(e){return {data:null,error:{code:e.code||'query_error'}};}
  }
}
class Query {
  constructor(db,table){Object.assign(this,{db,table,mode:'select',fields:'*',filters:[],orders:[],values:[],singleMode:false});}
  column(name){if(!this.db.tables.get(this.table).has(name))throw Error('Unknown column');return ident(name);}
  bind(value,column){const type=this.db.tables.get(this.table).get(column);this.values.push(['json','jsonb'].includes(type)&&value!==null?JSON.stringify(value):value);return '$'+this.values.length;}
  select(fields='*'){this.fields=fields;return this;}
  filter(column,op,value){this.filters.push([column,op,value]);return this;}
  eq(k,v){return this.filter(k,'=',v);} neq(k,v){return this.filter(k,'<>',v);}
  lt(k,v){return this.filter(k,'<',v);} lte(k,v){return this.filter(k,'<=',v);}
  gt(k,v){return this.filter(k,'>',v);} gte(k,v){return this.filter(k,'>=',v);}
  order(k,{ascending=true}={}){this.orders.push(this.column(k)+(ascending?' asc':' desc'));return this;}
  range(a,b){if(!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<a||b-a>1000)throw Error('Invalid range');this.offset=a;this.limit=b-a+1;return this;}
  maybeSingle(){this.singleMode=true;return this;} single(){this.singleMode='required';return this;}
  insert(data){this.mode='insert';this.data=data;return this;}
  upsert(data){this.mode='upsert';this.data=data;return this;}
  update(data){this.mode='update';this.data=data;return this;}
  delete(){this.mode='delete';return this;}
  then(resolve,reject){return this.execute().then(resolve,reject);}
  async execute(){
    try{
      const fields=this.fields==='*'?'*':this.fields.split(',').map(c=>this.column(c.trim())).join(',');
      let sql;
      const table='public.'+ident(this.table);
      if(['insert','upsert'].includes(this.mode)){
        const keys=Object.keys(this.data);const vals=keys.map(k=>this.bind(this.data[k],k));
        sql=`insert into ${table} (${keys.map(k=>this.column(k))}) values (${vals})`;
        if(this.mode==='upsert'){
          const key=this.db.tables.get(this.table).has('id')?'id':'key';
          sql+=` on conflict (${this.column(key)}) do update set `+keys.filter(k=>k!==key).map(k=>`${this.column(k)}=excluded.${this.column(k)}`).join(',');
        }
      }else if(this.mode==='update')sql=`update ${table} set `+Object.keys(this.data).map(k=>`${this.column(k)}=${this.bind(this.data[k],k)}`).join(',');
      else sql=this.mode==='delete'?`delete from ${table}`:`select ${fields} from ${table}`;
      if(this.filters.length)sql+=' where '+this.filters.map(([k,op,v])=>`${this.column(k)} ${op} ${this.bind(v,k)}`).join(' and ');
      if(this.mode==='select'){
        if(this.orders.length)sql+=' order by '+this.orders.join(',');
        sql+=' limit '+(this.singleMode?2:this.limit||10000);
        if(this.offset)sql+=' offset '+this.offset;
      }else sql+=' returning '+fields;
      const r=await this.db.query(sql,this.values);
      if(this.singleMode&&(r.rows.length>1||(this.singleMode==='required'&&!r.rows.length)))throw Error('Cardinality');
      return {data:this.singleMode?r.rows[0]||null:r.rows,error:null};
    }catch(e){return {data:null,error:{code:e.code||'query_error'}};}
  }
}
