const fail=code=>Object.assign(Error(code),{code});
// OCM operational metadata is NOT a live online/offline observation.
export function normalizeOcm(row,{provider,now=Date.now()}={}){
 if(!provider?.reviewed||row?.DataProviderID!==provider.id||row.DataProvider?.IsOpenDataLicensed!==true||row.DataProvider?.License!==provider.licenseText)throw fail('charging_license_review_required');
 const a=row.AddressInfo;if(!Number.isInteger(row.ID)||row.ID<=0||a?.Country?.ISOCode!=='UA'||!Number.isFinite(a.Latitude)||!Number.isFinite(a.Longitude)||a.Latitude<44||a.Latitude>53||a.Longitude<22||a.Longitude>41||typeof a.Title!=='string'||a.Title.length>200||!Array.isArray(row.Connections)||row.Connections.length>32)throw fail('charging_invalid_catalog');
 const connectors=row.Connections.map(c=>{if(!Number.isInteger(c.ID)||c.ID<=0||!Number.isFinite(c.PowerKW)||c.PowerKW<=0||c.PowerKW>2000||!Number.isInteger(c.ConnectionTypeID))throw fail('charging_invalid_connector');return {id:'ocm:'+row.ID+':'+c.ID,typeId:c.ConnectionTypeID,powerKw:c.PowerKW,quantity:Number.isInteger(c.Quantity)&&c.Quantity>0&&c.Quantity<=100?c.Quantity:1};});
 return {id:'ocm:'+row.ID,provider:'ocm',providerId:String(row.ID),label:a.Title,address:[a.Town,a.AddressLine1].filter(x=>typeof x==='string').join(', ').slice(0,300),latitude:a.Latitude,longitude:a.Longitude,connectors,catalogUpdatedAt:row.DateLastVerified&&Number.isFinite(Date.parse(row.DateLastVerified))?Date.parse(row.DateLastVerified):null,collectedAt:now,reportedOperational:row.StatusType?.IsOperational??null,attribution:{name:provider.name,url:provider.url,license:provider.license,licenseUrl:provider.licenseUrl}};
}
export class OpenChargeMap {
 constructor({key='',provider=null,fetcher=fetch}={}){Object.assign(this,{key,provider,fetcher});}
 get configured(){return !!(this.key&&this.provider?.reviewed);}
 async viewport({west,south,east,north}){if(!this.configured)throw fail('charging_catalog_not_configured');const u=new URL('https://api.openchargemap.io/v3/poi/');for(const [k,v]of Object.entries({output:'json',countrycode:'UA',opendata:'true',maxresults:'200',compact:'false',verbose:'false',boundingbox:`(${south},${west}),(${north},${east})`}))u.searchParams.set(k,v);
  const r=await this.fetcher(u,{headers:{'X-API-Key':this.key},redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok){await r.body?.cancel();throw fail('charging_source_unavailable');}let size=0;const chunks=[];for await(const c of r.body){size+=c.byteLength;if(size>2_000_000)throw fail('charging_catalog_too_large');chunks.push(c);}let rows;try{rows=JSON.parse(Buffer.concat(chunks));}catch{throw fail('charging_invalid_catalog');}if(!Array.isArray(rows)||rows.length>200)throw fail('charging_invalid_catalog');return rows.map(row=>normalizeOcm(row,{provider:this.provider}));
 }
}
