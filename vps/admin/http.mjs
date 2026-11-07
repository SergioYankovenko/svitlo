import {readFile} from 'node:fs/promises';import {pool} from '../db.js';import {createAdminServer} from './server.js';
const p=pool('admin',2),server=createAdminServer({pool:p,secret:(await readFile('/run/secrets/admin_secret','utf8')).trim(),origin:process.env.ADMIN_ORIGIN||'http://localhost:18768'});
server.headersTimeout=10000;server.requestTimeout=15000;server.maxConnections=20;server.listen(8080,'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(async()=>{await p.end();process.exit(0);});setTimeout(()=>process.exit(1),20000).unref();});
