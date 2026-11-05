import {regionError} from '../regions/dtek.js';
// Anonymous address lookup linked by https://www.zoe.com.ua/outage/.
export const ZOE_DEPLOYMENT='AKfycbwFgBo9W8JL_7FqghJ1hDiE-Fyxzs4GZJAq2xhTseOiv5ZnkusMKj0_g9R0DJKko19r';
export const ZOE_CITY_KEY='public-zaporizhzhia';
const invalid=()=>{throw regionError('invalid_source');};
const streetType=/^(?:(?:вул|пров(?:ул)?|бул|бульв|просп|пр|пл|наб)\.\s*|(?:вул|пров(?:ул)?|бул|бульв|просп|пр|пр-т|пл|площа|майдан|шосе|узвіз|тупик|наб|проїзд)\s+)/iu;
const safe=v=>typeof v==='string'&&v.length<=240&&!/[\x00-\x1f\x7f]/u.test(v);
export function parseZoePublic(body){
 if(typeof body!=='string'||!body.startsWith(")]}'"))invalid();let envelope,rows;
 try{envelope=JSON.parse(body.slice(4).trim());const packets=envelope.filter(x=>Array.isArray(x)&&x[0]==='op.exec');if(packets.length!==1||packets[0][1]?.[0]!==0||typeof packets[0][1][1]!=='string')invalid();rows=JSON.parse(packets[0][1][1]);}catch{invalid();}
 if(!Array.isArray(rows)||!rows.length||rows.length>50000)invalid();
 const streets=new Map();let skippedRows=0,acceptedRows=0;
 for(const row of rows){
  if(!Array.isArray(row)||row.length!==5)invalid();const [street,house,group]=row;
  // The published city sheet also contains unqualified settlement/garden names.
  // Keep these out of the city mapping until separately reviewed; never expand ranges.
  if(!safe(street)||!safe(house)||!street.trim()||!house.trim()||!streetType.test(street)||house.length>120){skippedRows++;continue;}
  if(typeof group!=='string'||group&&!/^[1-6]\.[12]$/.test(group))invalid();
  if(!streets.has(street))streets.set(street,new Map());const houses=streets.get(street);
  if(!houses.has(house))houses.set(house,new Set());if(group)houses.get(house).add(group);acceptedRows++;
 }
 if(!streets.size||streets.size>5000)invalid();return {streets,acceptedRows,skippedRows};
}
export function zoeResolution(groups,checkedAt){
 if(!groups?.size)return {state:'unknown',status:'not_queried',complete:false,checkedAt,lines:[],provenance:{sourceUnavailable:true,sourceState:'blank_published_queue'}};
 const codes=[...groups].sort();return {state:codes.length>1?'ambiguous':'resolved',status:codes.length>1?'ambiguous':'partial',complete:false,checkedAt,lines:codes.map(groupCode=>({groupCode})),provenance:{partial:true,source:'zoe-public-city-directory'}};
}
