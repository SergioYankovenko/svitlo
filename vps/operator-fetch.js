import {Agent,fetch as secureFetch} from 'undici';
import {rootCertificates,getCACertificates} from 'node:tls';
import {createPublicKey,verify} from 'node:crypto';
import certificates from '../server/operator-certificates.js';
import checks from '../server/operator-chain.js';
let dispatcher;
export function operatorFetch(url,options){
  if(new URL(url).hostname!=='cabinet.cherkasyoblenergo.com')return fetch(url,options);
  if(!dispatcher){
    // Same signed public intermediate chain as the released Android/Edge adapter.
    // Only this hostname gets the extra CA material; TLS hostname verification stays enabled.
    for(const check of checks){
      if(Date.now()<Date.parse(check.fromDate)||Date.now()>Date.parse(check.toDate))throw Error('Operator CA chain expired');
      const key=createPublicKey({key:Buffer.from(check.issuerKey,'base64'),format:'der',type:'spki'});
      if(!verify(check.hash.replace('-',''),Buffer.from(check.tbs,'base64'),key,Buffer.from(check.signature,'base64')))throw Error('Operator CA signature invalid');
    }
    dispatcher=new Agent({connect:{ca:[...rootCertificates,...getCACertificates('system'),...certificates],rejectUnauthorized:true},connections:4});
  }
  return secureFetch(url,{...options,dispatcher});
}
