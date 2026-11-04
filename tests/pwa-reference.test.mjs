import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../pwa/',import.meta.url),source=JSON.parse(await readFile(new URL('UI254-PROVENANCE.json',root),'utf8'));
const normalized=s=>s.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
const sha=s=>createHash('sha256').update(normalized(s)).digest('hex');
test('all UI254 component styles remain exact; the host adds no component overrides',async()=>{
 const names=(await readdir(root)).filter(n=>n.endsWith('.css')&&n!=='live.css');
 assert.ok(names.length>=15);
 for(const name of names)assert.equal(sha(await readFile(new URL(name,root),'utf8')),source.files[name],name);
 const host=await readFile(new URL('live.css',root),'utf8');assert.doesNotMatch(host,/\.phone|\.dialog|\.action|\.hour-tile|\.bottom-nav|\.preview-stage/);
});
test('approved policies, tutorial, mascot motion, typography fitter and pager are copied exactly',async()=>{
 for(const name of ['platform.js','reference-policy.js','device-ui-policy.js','experience.js','tour.js','lookup-ui.js','viewport.js','mascot-motion.js','native-ui.js','motion-ui.js','support-hint.js'])assert.equal(sha(await readFile(new URL(name,root),'utf8')),source.files[name],name);
});
test('production entry excludes LAB data, synthetic sensor transport and custom deferred windows',async()=>{
 const html=await readFile(new URL('index.html',root),'utf8');
 for(const source of ['sensor-lab.js','security-lab.js','catalog-snapshot.js','scenarios.js'])assert.ok(!html.includes('src="'+source));
 assert.doesNotMatch(html,/prototype-lab|lab-toggle|id="target"/);
 const runtime=await readFile(new URL('live-runtime.js',root),'utf8');assert.doesNotMatch(runtime,/live-native-dialog|function mapFallback|function chooseLine/);assert.match(runtime,/lines.length>1&&!lineId/);
});
