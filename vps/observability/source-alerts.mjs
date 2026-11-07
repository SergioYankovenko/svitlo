import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {dayKey,addDays} from '../../app/lib/time.js';
import {localStamp,parseHours} from '../regions/policy.js';

const sources={cherkasy:'Черкасиобленерго','dtek-kyiv':'ДТЕК Київ','dtek-kyiv-region':'ДТЕК Київщина','yasno-kyiv':'YASNO Київ'};
const invalidHours=new Set(['invalid_hour','incomplete_hours']);
const invalidYasno=new Set(['invalid_secondary_slots','incomplete_or_overlapping_secondary_day','secondary_status_conflicts_with_slots']);
const stamp=value=>Number.isSafeInteger(value)&&value>0;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const code=value=>typeof value==='string'&&/^[a-z0-9_]{1,80}$/.test(value)?value:'source_error';

export function condition(source,record,now) {
  if(!record?.slot||now-record.slot>450000)return 'missed_cycle';
  if(record.error)return code(record.error);
  const value=record.value;
  if(!object(value))return 'invalid_format';
  const today=dayKey(now);
  if(source==='cherkasy'){
    if(!stamp(value.checkedAt)||!Array.isArray(value.plans))return 'invalid_format';
    return value.plans.some(plan=>plan?.date>=today&&plan.date<=addDays(today,1)&&plan.uncertain===true)?'unconfirmed_subgroup_format':null;
  }
  if(source==='yasno-kyiv'){
    if(!object(value.daySchedules))return 'invalid_format';
    const malformed=Object.values(value.daySchedules).some(days=>Object.values(days).some(day=>
      day?.status==='InvalidSourceDay'||['ScheduleApplies','NoOutages'].includes(day?.status)&&invalidYasno.has(day.reason)));
    return malformed?'invalid_subgroup_format':null;
  }
  if(value.flags?.showTableFact===false||value.flags?.showTableSchedule===false)return null;
  if(!value.fact)return value.flags?.showTableFact===true?'invalid_format':null;
  if(!object(value.fact.data)||!localStamp(value.fact.update))return 'invalid_format';
  for(const [seconds,groups] of Object.entries(value.fact.data)){
    if(!/^\d{9,11}$/.test(seconds)||!object(groups))return 'invalid_format';
    const date=dayKey(Number(seconds)*1000);
    for(const [group,hours] of Object.entries(groups)){
      if(!/^GPV[1-9]\d{0,2}\.[1-9]\d?$/.test(group)||invalidHours.has(parseHours(hours,date).reason))return 'invalid_subgroup_format';
    }
  }
  return null;
}

export function advance(state,records,now,enabled) {
  for(const [source,record] of Object.entries(records)){
    if(!Object.hasOwn(sources,source))continue;
    const issue=condition(source,record,now), previous=state.sources[source];
    if(previous?.issue===issue&&previous?.enabled===enabled)continue;
    state.sources[source]={issue,enabled};
    if(!enabled||!issue&&(!previous?.enabled||!previous.issue))continue;
    const slot=record?.slot||Math.floor(now/300000)*300000;
    const id=`${source}/${slot}/${issue||'recovered'}`;
    if(state.pending.some(event=>event.id===id))continue;
    state.pending.push({id,source,issue,at:now});
  }
  if(state.pending.length>100){state.dropped=(state.dropped||0)+state.pending.length-100;state.pending.splice(0,state.pending.length-100);}
  return state;
}

const messages={missed_cycle:'пропущено цикл перевірки',invalid_format:'некоректний формат відповіді',
  invalid_subgroup_format:'некоректні дані підчерги',unconfirmed_subgroup_format:'частину підчерг не вдалося підтвердити',
  forbidden:'джерело відхилило запит',rate_limited:'джерело обмежило запити',timeout:'джерело не відповіло вчасно',
  operator_paused:'джерело призупинено',partial:'отримано неповні дані',invalid_response:'некоректна відповідь'};
const time=value=>new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',dateStyle:'short',timeStyle:'medium'}).format(value);
function message(event){
  const title=event.issue?'Помилка джерела ГПВ':'Джерело ГПВ відновилося';
  const detail=event.issue?`\n${messages[event.issue]||'помилка джерела'} (${event.issue})`:'';
  return `Світло · тестовий VPS\n${title}\n${sources[event.source]}${detail}\n${time(event.at)} за Києвом\n${event.id}`;
}

export async function send(config,text,fetcher=fetch) {
  let response;
  try{
    response=await fetcher(`https://api.telegram.org/bot${config.token}/sendMessage`,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:config.chatId,text,link_preview_options:{is_disabled:true}}),
    });
    const result=await response.json();
    if(response.ok&&result?.ok===true&&String(result.result?.chat?.id)===config.chatId)return;
    const seconds=Number(result?.parameters?.retry_after);
    throw Object.assign(new Error('telegram_delivery_rejected'),{retry:response.status===429&&Number.isFinite(seconds)?Math.min(3600,Math.max(1,seconds))*1000:response.status===403||response.status===401?300000:0});
  }catch(error){
    throw Object.assign(new Error('telegram_delivery_failed'),{retry:error.retry||0});
  }
}

async function config(){
  try{
    const value=JSON.parse(await readFile('/run/alerts-secrets/telegram.json','utf8'));
    if(!/^\d{6,16}:[A-Za-z0-9_-]{30,80}$/.test(value.token||'')||!/^\d{5,20}$/.test(value.chatId||'')||value.bot!=='svitlo_guru_bot'||!stamp(value.configuredAt))return null;
    return value;
  }catch{return null;}
}

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(){
  await mkdir('/state',{recursive:true});
  const path='/state/alerts.json';
  let state;
  try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('alert_state_unreadable');state={sources:{},pending:[]};}
  const pool=new pg.Pool({host:'postgres',database:'svitlo_staging',user:'svitlo_source_alerts',
    password:(await readFile('/run/alerts-secrets/database-password','utf8')).trim(),max:1,statement_timeout:3500,connectionTimeoutMillis:3500});
  pool.on('error',()=>console.error('source_alerts_database_connection_lost'));
  const save=async next=>{
    await writeFile(path+'.tmp',JSON.stringify(next),{mode:0o600,flush:true});
    await rename(path+'.tmp',path);
    state=next;
  };
  let running=true,nextDelivery=0,retries=0;
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{running=false;});
  let logged=null,configuredAt=null;
  while(running){
    const now=Date.now(),telegram=await config();
    try{
      const {rows}=await pool.query('select source,svitlo_source_history.group_plan(source) record from unnest($1::text[]) source',[Object.keys(sources)]);
      if(rows.length!==Object.keys(sources).length)throw Error('source_alerts_database_incomplete');
      const next=advance(structuredClone(state),Object.fromEntries(rows.map(row=>[row.source,row.record])),now,!!telegram);
      if(JSON.stringify(state)!==JSON.stringify(next))await save(next);
      const status=telegram?'delivery_configured':'waiting_for_telegram_credentials';
      if(logged!==status){console.log(JSON.stringify({event:'source_alerts_ready',status,sources:rows.length}));logged=status;}
    }catch{if(logged!=='database_unavailable'){console.error('source_alerts_database_unavailable');logged='database_unavailable';}}
    if(telegram?.configuredAt!==configuredAt){configuredAt=telegram?.configuredAt;nextDelivery=0;retries=0;}
    if(telegram&&now>=nextDelivery){
      try{
        if(state.verifiedConfig!==telegram.configuredAt){
          await send(telegram,'Світло · тестовий VPS\nКанал службових сповіщень ГПВ підключено.');
          await save({...state,verifiedConfig:telegram.configuredAt});
          console.log('source_alerts_telegram_delivery_verified');
        }
        const event=state.pending[0];
        if(event){
          await send(telegram,message(event));
          await save({...state,pending:state.pending.slice(1)});
          console.log(JSON.stringify({event:'source_alerts_sent',source:event.source,issue:event.issue}));
        }
        retries=0;
      }catch(error){
        nextDelivery=Date.now()+Math.max(error.retry||0,Math.min(300000,5000*2**Math.min(retries++,6)));
        console.error('source_alerts_delivery_retry');
      }
    }
    await wait(5000);
  }
  await pool.end();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  run().catch(()=>{console.error('source_alerts_start_failed');process.exitCode=1;});
}
