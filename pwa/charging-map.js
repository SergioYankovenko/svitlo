import {universalRequest} from './core/api.js';
const status=document.querySelector('#status'),details=document.querySelector('#details');let sequence=0,abort=null,markers=[];
try{
 const cap=await universalRequest('capabilities');if(!cap.charging?.enabled)throw Error('Карта зарядок ще готується.');
 const {Map,Marker,setWorkerUrl}=await import('./vendor/maplibre/maplibre-gl.mjs');setWorkerUrl(new URL('./vendor/maplibre/maplibre-gl-worker.mjs',import.meta.url).href);
 const map=new Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[30.523,50.45],zoom:10,minZoom:7,maxBounds:[[22,44],[41,53]],attributionControl:true});
 // Navigation is viewport-only. No GeolocateControl, GPS prompt or travel estimate.
 async function load(){const id=++sequence;abort?.abort();abort=new AbortController();const b=map.getBounds(),bounds={west:Math.max(22,b.getWest()),east:Math.min(41,b.getEast()),south:Math.max(44,b.getSouth()),north:Math.min(53,b.getNorth())};status.textContent='Оновлюємо станції в цій частині карти…';
  try{const result=await universalRequest('charging',{action:'viewport',bounds},{signal:abort.signal});if(id!==sequence)return;markers.forEach(m=>m.remove());markers=[];
   for(const station of result.stations){const element=document.createElement('button');element.className='station';element.textContent='ϟ';element.ariaLabel=station.label;element.onclick=()=>show(station);markers.push(new Marker({element}).setLngLat([station.longitude,station.latitude]).addTo(map));}
   status.textContent=result.stations.length?`Станцій на карті: ${result.stations.length}. Фактичний стан конекторів невідомий.`:'У цій частині карти поки немає станцій у нашому каталозі.';
  }catch(e){if(id===sequence&&e.name!=='AbortError')status.textContent=e.message;}
 }
 async function show(s){details.replaceChildren();const title=document.createElement('h2');title.textContent=s.label;details.append(title);const address=document.createElement('p');address.textContent=s.address;details.append(address);const source=document.createElement('a');source.href=/^https:\/\/(?:www\.)?openchargemap\.org(?:\/|$)/.test(s.attribution.url)?s.attribution.url:'https://openchargemap.org/';source.rel='noopener noreferrer';source.textContent=s.attribution.name+' · '+s.attribution.license;details.append(source);
  const p=document.createElement('p');p.textContent='Перевіряємо прив’язку до електромережі…';details.append(p);
  try{const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Kyiv'}).format(Date.now()),f=await universalRequest('charging',{action:'forecast',stationId:s.id,date});if(!details.contains(p))return;p.textContent=f.state==='conditional'?'За графіком мережі: '+f.gridPlan.windows.map(w=>new Date(w.start).toLocaleTimeString('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'})+'–'+new Date(w.end).toLocaleTimeString('uk-UA',{timeZone:'Europe/Kyiv',hour:'2-digit',minute:'2-digit'})).join(', ')+'. Робота зарядки не гарантована; резервне живлення: '+({yes:'є',no:'немає',unknown:'невідомо'}[f.backupPower])+'.':'Немає перевіреного прогнозу живлення цієї станції.';}catch{p.textContent='Прогноз поки недоступний.';}
 }
 map.on('load',load);map.on('moveend',load);
}catch(e){status.textContent=e.message;}
