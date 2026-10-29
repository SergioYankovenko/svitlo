import {writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validatePublic} from './contract.mjs';

// Server-to-server read-only export credential. Never put it in the generated file or log output.
const key=process.env.ANDROID_MESSAGES_EXPORT_KEY;
if(!key||key.length<32)throw new Error('Missing export credential');
const response=await fetch('https://ovcmluucwzsuflusebcc.supabase.co/functions/v1/svitlo-android-messages',{
  headers:{'X-Export-Key':key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000),
});
if(response.status!==200)throw new Error(`Export HTTP ${response.status}`);
const reader=response.body.getReader();const chunks=[];let size=0;
for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw new Error('Export too large');}chunks.push(value);}
const value=validatePublic(JSON.parse(Buffer.concat(chunks).toString('utf8')));
const target=resolve(process.argv[2]||'android-messages.json');const temporary=target+'.new';
await writeFile(temporary,JSON.stringify(value)+'\n',{encoding:'utf8',mode:0o644});await rename(temporary,target);
console.log(`Public export validated: ${value.messages.length} messages`);
