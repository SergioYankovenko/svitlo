import {runtime} from '../runtime.js';
import {dayKey} from '../../app/lib/time.js';
const options={};
for(const argument of process.argv.slice(2)){const match=argument.match(/^--(fromDate|toDate|scheduleDate|group)=(.{1,20})$/);if(!match)throw Error('Use --fromDate=YYYY-MM-DD --toDate=YYYY-MM-DD --group=23.1 --scheduleDate=YYYY-MM-DD');options[match[1]]=match[2];}
options.fromDate??=dayKey(Date.now());
const rt=await runtime('worker');
try{console.log(JSON.stringify(await rt.sourceHistory.report(options)));}finally{await rt.p.end();}
