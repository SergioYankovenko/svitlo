// Fixed public source refresh. Run only through the owner maintenance container.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {loadBundle} from '../geography/bundle.mjs';
import {fetchTerritories,importTerritories} from './territory.mjs';
const {data}=await loadBundle(),snapshot=await fetchTerritories(data.nodes);
const c=new pg.Client({host:process.env.PGHOST||'postgres',database:process.env.PGDATABASE||'svitlo_staging',user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim(),options:'-c statement_timeout=60000 -c lock_timeout=5000'});
await c.connect();try{console.log(JSON.stringify({scope:'official_territory_refresh',...await importTerritories(c,snapshot),sourceHash:snapshot.sourceSha256,editionHash:snapshot.editionHash,diagnostics:snapshot.diagnostics}));}finally{await c.end();}
