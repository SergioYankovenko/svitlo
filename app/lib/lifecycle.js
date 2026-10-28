export function validDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const [y,m,d]=value.split('-').map(Number);
  if(y<1||m<1||m>12||d<1||d>31)return false;
  const date=new Date(0);date.setUTCFullYear(y,m-1,d);date.setUTCHours(12,0,0,0);
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d;
}
export const validProfileId=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||'');
// The schedule engine uses the modern Kyiv clock rules, not historical offsets.
export const routeDate=value=>validDate(value)&&value>='2000-01-01'&&value<='2099-12-31';
export function readRoute(search) {
  const q=new URLSearchParams(search),profile=q.get('profile'),date=q.get('date');
  return {profile:validProfileId(profile)?profile:null,date:routeDate(date)?date:null,
    invalid:!!(profile&&!validProfileId(profile)||date&&!routeDate(date))};
}
export class Lifecycle {
  constructor(){this.owner=null;this.epoch=0;this.intent=0;this.phase='loading';}
  setOwner(owner){if(owner!==this.owner){this.owner=owner;this.epoch++;this.intent++;return true;}return false;}
  invalidate(){this.epoch++;this.intent++;}
  select(){this.intent++;}
  capture(){return {owner:this.owner,epoch:this.epoch,intent:this.intent};}
  current(stamp,intent=false){return !!stamp&&stamp.owner===this.owner&&stamp.epoch===this.epoch&&(!intent||stamp.intent===this.intent);}
}
