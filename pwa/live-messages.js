import {messageTitle} from './core/lib/notifications.js';

// A source retry may leave several IDs for the same first publication.
// Keep real revisions, special notices, scopes and different dates independent.
export function visibleMessages(messages=[]){
  if(!Array.isArray(messages))return [];
  const ids=new Set(),publications=new Set();
  return messages.filter(m=>{
    if(!m||typeof m!=='object')return false;
    if(m.id&&ids.has(m.id))return false;
    if(m.id)ids.add(m.id);
    const title=messageTitle(m);
    if(m.kind!=='schedule'||m.special||!Number.isFinite(m.publishedAt)||m.publishedAt<=0||
      m.revisionType==='change'||/оновлен|скас|непевн|уточн|невизнач/i.test(title||''))return true;
    const key=JSON.stringify([m.addressId||'',m.lineId||'',m.scope||'',m.date,m.queue||'',m.publishedAt,title,m.url||'',m.planSignature||'']);
    if(publications.has(key))return false;
    publications.add(key);return true;
  });
}
