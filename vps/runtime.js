import {corePorts} from './modules/ports.js';
import {unresolvedLog} from './universal/unresolved-log.js';
import {adapterFor} from './universal/adapters.js';
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
import {pilotPush} from './push.js';
import {SourceHistory} from './regions/source-history.js';
import {Geography} from './geography/service.mjs';
import {DiscoveryCatalog} from './discovery/catalog.mjs';
import {RegionalDiscoverySources} from './discovery/regional-sources.mjs';
import {SourceEvidence,observedPublicFetch} from './sources/evidence.js';
import {AddressSearch} from './search/service.js';
import {DictionarySearch} from './search/dictionary.js';
import {configuredMeili} from './search/meili.js';

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
  const sourceEvidence=new SourceEvidence(bridge,{onError:code=>console.error(JSON.stringify({event:code}))}),fetcher=observedPublicFetch(operatorFetch,value=>sourceEvidence.record(value),async id=>(await bridge.query('select svitlo_admin.source_allowed($1) value',[id])).rows[0].value);
  const source=new PrivateSource(providerTransport(db,fetcher),{dictionaries:new SharedDictionaries(db),feed:new SharedFeed(db),categories:new SharedCategories(db,secret),departmentSchedules:new DepartmentSchedules({db,bridge,secret})});
  const delivery=await pilotPush(p);
  const options={db,source,...delivery,jobBudgetMs:45000,
    defaultPreferences:{schedule:false,publication:false,change:false,emergency:false,reminder:false,restoration:false,lead:30}};
  const regions=new Regions({db,bridge,secret,fetcher}),legacy=new Service(options),reader=new UniversalReader({db,bridge,legacy,source,secret,regions,sourceEvidence});
  const addressSearch=new AddressSearch({bridge,client:configuredMeili('read'),secret});reader.catalog.searchPort=addressSearch;
  const regionalDiscovery=new RegionalDiscoverySources({fetcher,gate:op=>regions.gate(op),finish:(...args)=>regions.finish(...args)});
  const maps=new MapAddresses({bridge,catalog:reader.catalog,secret});
  const service=new UniversalService({...options,maps,unresolvedLog:role==='api'?unresolvedLog('/app-logs/unresolved-addresses.ndjson'):null},reader);
  const sourceHistory=new SourceHistory({bridge,regions,enabled:role==='worker'&&process.env.SOURCE_HISTORY_ENABLED==='true'});
  return {ports:corePorts({reader,service}),p,bridge,db,source,service,legacy,reader,maps,regions,regionalDiscovery,sourceHistory,sourceEvidence,addressSearch,geography:new Geography(bridge,{supports:op=>!!adapterFor(op,reader)}),discoveryCatalog:new DiscoveryCatalog({bridge,source,reader,regions,dictionarySearch:new DictionarySearch({bridge,client:configuredMeili('read'),secret})}),secret,...delivery};
}
