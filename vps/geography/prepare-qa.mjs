// Owner import only in a disposable restored database, before any HTTP QA suite.
import pg from 'pg';import {readFile} from 'node:fs/promises';import {importGeography} from './import.mjs';import {seedDiscovery} from '../discovery/seed.mjs';
import {importTerritories} from '../discovery/territory.mjs';
const database=process.env.PGDATABASE;
if(!/^svitlo_(phone|history|map|kyiv|pwa|sources|subscriptions|geography|discovery|regional|lines)_qa_\d+$/.test(database||''))throw Error('Disposable restored geography QA database required');
const c=new pg.Client({host:'postgres',database,user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim(),options:'-c statement_timeout=30000 -c lock_timeout=5000'});
await c.connect();try{console.log(JSON.stringify({geographyQaImport:await importGeography(c),discoverySeeded:await seedDiscovery(c),territoryImport:await importTerritories(c)}));}finally{await c.end();}
