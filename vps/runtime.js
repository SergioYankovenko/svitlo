import {readFileSync} from 'node:fs';
import {Database} from '../server/database.js';
import {Source} from '../server/source.js';
import {Service} from '../server/service.js';
import {SharedDictionaries} from '../server/shared-dictionaries.js';
import {SharedFeed} from '../server/shared-feed.js';
import {SharedCategories} from '../server/shared-categories.js';
import {providerTransport} from '../server/provider-transport.js';
import {operatorFetch} from './operator-fetch.js';
import {PgBridge,pool} from './db.js';
import {UniversalReader} from './universal/reader.js';
import {UniversalService} from './universal/service.js';
import {MapAddresses} from './maps/service.js';
import {Regions} from './regions/service.js';
import {DepartmentSchedules} from './department-cache.js';

// Accounts remain transient adapter inputs; they never enter the persistent address/profile/catalog.
export class PrivateSource extends Source {
  constructor(fetcher,options){super(fetcher,options);this.accounts=new Map();}
  key(a){return JSON.stringify([a.department,a.cityId,a.streetId,a.house]);}
  async resolve(a){const value=await super.resolve(a),{account,...safe}=value;
    if(account){if(this.accounts.size>1000)this.accounts.clear();this.accounts.set(this.key(a),{account,until:Date.now()+900000});}
    return safe;
  }
  async address(a,...args){const account=this.accounts.get(this.key(a));return super.address(account?.until>Date.now()?{...a,account:account.account}:a,...args);}
}
export async function runtime(role='api'){
  const p=pool(role,role==='worker'?2:4),bridge=await new PgBridge(p).init();
  const db=new Database(bridge,{scheduledMaintenance:true});
  if(role==='worker')db.due=async(now,amount)=>(await p.query(`update public.svitlo_profiles set lease_until=$1+180000 where id in
    (select id from public.svitlo_profiles where coalesce(address->>'mapOnly','false')<>'true' and lease_until<$1 and ((next_check>0 and next_check<=$1) or (next_check=0 and last_checked<$1-3600000))
    order by next_check,last_checked limit least($2,4) for update skip locked) returning *`,[now,amount])).rows;
  const secret=readFileSync('/run/secrets/session_secret','utf8').trim();
  const source=new PrivateSource(providerTransport(db,operatorFetch),{dictionaries:new SharedDictionaries(db),feed:new SharedFeed(db),categories:new SharedCategories(db,secret),departmentSchedules:new DepartmentSchedules({db,bridge,secret})});
  const options={db,source,vapid:'',push:async()=>{throw Error('STAGING_DELIVERY_DISABLED');},jobBudgetMs:45000};
  const regions=new Regions({db,bridge,secret}),legacy=new Service(options),reader=new UniversalReader({db,bridge,legacy,source,secret,regions});
  const maps=new MapAddresses({bridge,catalog:reader.catalog,secret});
  const service=new UniversalService({...options,maps},reader);
  return {p,bridge,db,source,service,legacy,reader,maps,regions,secret};
}
