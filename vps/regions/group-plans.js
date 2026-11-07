import {failureCode} from '../../server/source-errors.js';

export const GROUP_PLAN_MAX_AGE=360000;

export class GroupPlans {
  constructor(bridge,{now=Date.now}={}) {
    this.bridge=bridge;
    this.now=now;
    this.cache=new Map();
  }

  async read(source) {
    const cached=this.cache.get(source);
    if(cached?.until>this.now())return cached.result;
    const result=this.bridge.query('select svitlo_source_history.group_plan($1) value',[source])
      .then(r=>r.rows[0].value);
    this.cache.set(source,{until:this.now()+10000,result});
    try{return await result;}
    catch(error){if(this.cache.get(source)?.result===result)this.cache.delete(source);throw error;}
  }

  async captureCherkasy(source,now=this.now()) {
    try {
      const previous=(await this.read('cherkasy'))?.value||{};
      const value=await source.loadFeed(now,previous,undefined,{pages:1,size:30,publishedSince:now-2*86400000});
      const {plans,emergencies,maintenance,checkedAt,partial,feedError}=value;
      return {value:{plans,emergencies,maintenance,checkedAt,partial},error:partial?feedError||'partial':null};
    } catch(error) {
      return {error:failureCode(error)};
    } finally {
      this.cache.delete('cherkasy');
    }
  }

  async cherkasy() {
    const record=await this.read('cherkasy');
    const value=record?.value||{plans:[],emergencies:[],maintenance:[],checkedAt:0};
    const error=record?.error||(value.checkedAt+GROUP_PLAN_MAX_AGE<=this.now()?'group_plan_stale':null);
    return {...value,groupSchedule:true,partial:!!error||value.partial===true,...(error?{feedError:error}:{})};
  }

  async dtek(operator) {
    const [primary,secondary]=await Promise.all([
      this.read(operator==='ua-kyiv-dtek'?'dtek-kyiv':'dtek-kyiv-region'),
      operator==='ua-kyiv-dtek'?this.read('yasno-kyiv'):null,
    ]);
    const usable=record=>record?.checkedAt>0&&!record.error&&record.checkedAt+GROUP_PLAN_MAX_AGE>this.now();
    return {
      primary:{fact:primary?.value?.fact,flags:primary?.value?.flags||{},checkedAt:primary?.checkedAt||0,fresh:usable(primary)},
      secondary:usable(secondary)&&secondary.slot===primary?.slot?{...secondary.value,checkedAt:secondary.checkedAt}:null,
    };
  }
}
