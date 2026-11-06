// A quota counts canonical homes; a profile is one independently selected line.
export const MAX_LINE_PROFILES=320,MAX_ADDRESS_GROUPS=10;
export function addressGroupKey(p){
 const a=p?.address||p||{};
 return a.canonicalAddressId||a.addressGroupId?'canonical:'+(a.canonicalAddressId||a.addressGroupId):p?.id&&!a.department?'profile:'+p.id:JSON.stringify([a.department,a.cityId,a.streetId,a.house]);
}
export const addressGroupCount=profiles=>new Set(profiles.map(addressGroupKey)).size;
export function confirmedLines(result){
 const r=result?.resolution;
 if(!r?.complete||!['resolved','ambiguous'].includes(r.state)||r.provenance?.sourceUnavailable||!Array.isArray(r.lines)||r.lines.length>32)return [];
 const seen=new Set();
 return r.lines.filter(l=>{const key=l.groupCode||l.key||l.id;if(!l.id||!key||seen.has(key))return false;seen.add(key);return true;});
}
export function lineGuideKey(addresses,active){
 const a=addresses.find(a=>a.id===active);
 if(!a?.addressGroupId||!a.lineNumber)return null;
 const lines=addresses.filter(x=>x.addressGroupId===a.addressGroupId&&x.lineNumber);
 return lines.length>1?a.addressGroupId+':'+lines.map(x=>x.lineId).sort().join(','):null;
}
