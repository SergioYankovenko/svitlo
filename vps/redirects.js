const defaults={sensor:'https://www.svitlo.guru',subscription:'https://www.svitlo.guru','schedule-help':'https://www.svitlo.guru'};
const variables={sensor:'SVITLO_SENSOR_INFO_URL',subscription:'SVITLO_SUBSCRIPTION_URL','schedule-help':'SVITLO_SCHEDULE_HELP_URL'};
export function redirectTarget(path,env=process.env){
  const key=path.startsWith('/go/')?path.slice(4):'';if(!Object.hasOwn(defaults,key))return null;
  try{const url=new URL(env[variables[key]]||defaults[key]);if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;}catch{}
  return defaults[key];
}
