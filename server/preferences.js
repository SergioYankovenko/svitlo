import {preferences} from '../app/lib/notifications.js';
// Legacy writes can change their schedule master but cannot erase independent flags.
export function mergePreferences(old={}, patch={}) {
  const base=preferences(old), split=old._scheduleSplit===true || typeof patch.publication==='boolean' || typeof patch.change==='boolean', allowed=['schedule','publication','change','emergency','reminder','restoration'];
  if(!split && typeof patch.schedule==='boolean'){base.publication=patch.schedule;base.change=patch.schedule;}
  base._scheduleSplit=split;
  for(const key of allowed)if(typeof patch[key]==='boolean')base[key]=patch[key];
  if([5,15,30,60].includes(+patch.lead))base.lead=+patch.lead;
  return base;
}
