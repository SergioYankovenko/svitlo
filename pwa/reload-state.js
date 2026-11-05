const KEY='svitlo.pwa.v2.reload-view',tabs=['home','messages','options'];
const focus=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(v)?v:null;
export function rememberReloadView(storage,owner,view,now=Date.now()){
 try{if(!owner||!tabs.includes(view.tab))return false;const value={owner,tab:view.tab,scroll:Math.max(0,Math.min(10000000,Number(view.scroll)||0)),focusAction:focus(view.focusAction),at:now};(typeof storage==='function'?storage():storage).setItem(KEY,JSON.stringify(value));return true;}catch{return false;}
}
export function takeReloadView(storage,owner,now=Date.now()){
 try{const store=typeof storage==='function'?storage():storage,raw=store.getItem(KEY);store.removeItem(KEY);if(!raw||raw.length>4096)return null;const v=JSON.parse(raw);
  if(!owner||v.owner!==owner||!tabs.includes(v.tab)||!Number.isFinite(v.at)||v.at>now||now-v.at>300000||!Number.isFinite(v.scroll)||v.scroll<0||v.scroll>10000000)return null;
  return {tab:v.tab,scroll:v.scroll,focusAction:focus(v.focusAction)};
 }catch{return null;}
}
