import {mkdir,cp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('dist',{recursive:true});await rm('dist/app',{recursive:true,force:true});
await cp('app','dist/app',{recursive:true});
// This build has no production origin, public Supabase key or browser Supabase SDK.
await rm('dist/app/vendor',{recursive:true,force:true});
await writeFile('dist/app/config.js',`export default ${JSON.stringify({apiUrl:'/api',transport:'vps',local:false,scope:'isolated-staging'})};\n`);
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]))).flat();}
const files=(await walk('dist/app')).sort();
for(const file of files.filter(f=>/\.(?:js|html|css|json|webmanifest|svg)$/.test(f)))await writeFile(file,(await readFile(file,'utf8')).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'));
const hash=createHash('sha256');hash.update(await readFile(new URL(import.meta.url)));for(const f of files.filter(f=>!f.endsWith('/sw.js')))hash.update(await readFile(f));
const version='svitlo-stage-'+hash.digest('hex').slice(0,12);
const html=(await readFile('dist/app/index.html','utf8')).replace(/data-shell="[^"]*"/,`data-shell="${version}"`)
  .replace('<title>Світло</title>','<title>Світло — тест VPS</title>')
  .replace('</head>','<meta name="robots" content="noindex,nofollow"></head>')
  .replace(/(<body[^>]*>)/,'$1<aside style="text-align:center;padding:8px;font:13px system-ui;background:#1d3b2b;color:#c2d997" role="status">Тестова версія VPS · сповіщення вимкнені</aside>');
await writeFile('dist/app/index.html',html);
const list=files.filter(f=>!f.endsWith('/sw.js')),integrity={};
for(const f of list)integrity['./'+f.slice(9)]=createHash('sha256').update(await readFile(f)).digest('hex');
let sw=await readFile('dist/app/sw.js','utf8');
sw=sw.replace(/(["'])svitlo-pwa-[^"']+\1/,JSON.stringify(version));
sw=sw.replace(/const SHELL = \[[\s\S]*?\];/,'const SHELL = '+JSON.stringify(['./',...list.map(f=>'./'+f.slice(9))])+';');
sw=sw.replace(/const HASHES = \{[^;]*\};/,'const HASHES = '+JSON.stringify(integrity)+';');
sw=sw.replace('k.startsWith("svitlo-pwa-")','k.startsWith("svitlo-stage-")');
await writeFile('dist/app/sw.js',sw);await writeFile('dist/release.json',JSON.stringify({version,files:files.length,scope:'isolated-staging'}));
console.log(JSON.stringify({version,files:files.length}));
