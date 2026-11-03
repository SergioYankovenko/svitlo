import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {seedQa} from './seed.js';
const c=new pg.Client({host:'postgres',database:'svitlo_staging',user:'svitlo_owner',password:(await readFile('/run/secrets/owner_password','utf8')).trim()});await c.connect();
try{await c.query('begin');await seedQa(c,'qa-next','qa-alt-v1','Ще один регіон (синтетичний QA)');await c.query('commit');console.log(JSON.stringify({enabled:'qa-next',synthetic:true,frontendChanged:false}));}catch(e){await c.query('rollback');throw e;}finally{await c.end();}
