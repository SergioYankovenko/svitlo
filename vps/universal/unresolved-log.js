import {appendFile,readFile,stat,rename,unlink,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
// Owner-only bind mount, never under dist/. Bounded rotation and a cross-slot lock.
export function unresolvedLog(file,{maxBytes=5*1024*1024,rotations=4,now=Date.now}={}){
  return async(address,profileId)=>{
    if(!address.queueUnresolved)return;
    const caseId=createHash('sha256').update(profileId+'|'+address.canonicalAddressId).digest('hex');
    let lock;
    for(let i=0;i<40&&!lock;i++){
      try{lock=await open(file+'.lock','wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,25));}
    }
    if(!lock)throw Object.assign(Error('Журнал уточнення адрес тимчасово зайнятий. Спробуйте ще раз.'),{status:503});
    try{
      for(let i=0;i<=rotations;i++){
        try{const contents=await readFile(file+(i?'.'+i:''),'utf8');if(contents.split('\n').some(line=>line.includes('"caseId":"'+caseId+'"')))return;}
        catch(e){if(e.code!=='ENOENT')throw e;}
      }
      const record={schemaVersion:1,caseId,at:new Date(now()).toISOString(),operation:'continue_without_queue',
        addressId:address.canonicalAddressId,operatorId:address.operatorId,city:address.city,street:address.street,house:address.house,
        reason:address.queueReason,candidates:address.queueCandidates||[]};
      const row=JSON.stringify(record)+'\n';if(Buffer.byteLength(row)>4096)throw Error('Unresolved record too large');
      let size=0;try{size=(await stat(file)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(size+Buffer.byteLength(row)>maxBytes){
        await unlink(file+'.'+rotations).catch(e=>{if(e.code!=='ENOENT')throw e;});
        for(let i=rotations-1;i>=0;i--)await rename(file+(i?'.'+i:''),file+'.'+(i+1)).catch(e=>{if(e.code!=='ENOENT')throw e;});
      }
      await appendFile(file,row,{mode:0o600});
    }finally{await lock.close();await unlink(file+'.lock');}
  };
}
