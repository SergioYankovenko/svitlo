import {runtime} from '../runtime.js';
if(process.env.PGDATABASE!=='svitlo_staging'&&!/^svitlo_kyiv_qa_\d+$/.test(process.env.PGDATABASE||''))throw Error('Private staging or disposable Kyiv QA DB required');
const rt=await runtime('worker');try{for(const result of await rt.regions.seed())console.log(JSON.stringify({scope:'private-region-catalog',...result}));}finally{await rt.p.end();}
