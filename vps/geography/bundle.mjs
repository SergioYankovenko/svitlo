import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function loadBundle(){
 const manifest=JSON.parse(await readFile(new URL('./data/manifest.json',import.meta.url),'utf8'));
 const zip=await readFile(new URL('./data/directory.json.gz',import.meta.url));
 if(zip.length>10000000||sha(zip)!==manifest.compressedSha256)throw Error('Geography compressed bundle integrity mismatch');
 const body=gunzipSync(zip,{maxOutputLength:40000000});if(sha(body)!==manifest.sha256)throw Error('Geography bundle integrity mismatch');
 const data=JSON.parse(body);
 if(data.nodes.length!==manifest.nodeCount||data.routes.length!==manifest.routeCount||data.links.length!==manifest.linkCount)throw Error('Geography bundle count mismatch');
 const ids=new Set(data.nodes.map(n=>n.code));if(ids.size!==data.nodes.length)throw Error('Duplicate geography identity');
 for(const n of data.nodes)if(!/^UA[0-9]{17}$/.test(n.code)||!n.name||n.parentCode&&!ids.has(n.parentCode)||!ids.has(n.regionCode))throw Error('Geography identity/parent mismatch');
 return {manifest,data};
}
