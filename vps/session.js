import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
export class Sessions {
  constructor(pool,secret,{secure=false}={}){Object.assign(this,{pool,secret,secure});}
  token(req){const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('svitlo_stage='))?.slice(13);return /^[a-f0-9]{64}$/.test(value||'')?value:null;}
  csrf(token){return createHmac('sha256',this.secret).update('csrf:'+token).digest('hex');}
  validCsrf(req,session){const value=req.headers['x-svitlo-csrf'];return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&timingSafeEqual(Buffer.from(value),Buffer.from(session.csrf));}
  cookie(token,maxAge=2592000){return `svitlo_stage=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure?'; Secure':''}`;}
  async read(req){const token=this.token(req);if(!token)return null;
    const r=await this.pool.query('select owner,expires_at from svitlo_vps.sessions where token_hash=$1 and expires_at>now() and svitlo_admin.account_allowed(owner)',[sha(token)]);
    let row=r.rows[0];if(!row)return null;let renewed=false;
    if(row.expires_at.getTime()-Date.now()<7*86400000){const next=await this.pool.query("update svitlo_vps.sessions set expires_at=now()+interval '30 days' where token_hash=$1 and expires_at>now() and svitlo_admin.account_allowed(owner) returning owner,expires_at",[sha(token)]);if(!next.rows[0])return null;row=next.rows[0];renewed=true;}
    return {owner:row.owner,expiresAt:row.expires_at.getTime(),csrf:this.csrf(token),token,...(renewed?{renewed:true}:{})};
  }
  public(s){return {user:{id:s.owner},access_token:s.csrf,csrf_token:s.csrf,expires_at:Math.floor(s.expiresAt/1000)};}
  async create(){const token=randomBytes(32).toString('hex'),owner=randomUUID(),c=await this.pool.connect();
    try{await c.query('begin');await c.query('insert into auth.users(id) values($1)',[owner]);
      await c.query("insert into svitlo_vps.sessions(token_hash,owner,expires_at) values($1,$2,now()+interval '30 days')",[sha(token),owner]);await c.query('commit');
    }catch(e){await c.query('rollback');throw e;}finally{c.release();}
    return {token,owner,expiresAt:Date.now()+2592000000,csrf:this.csrf(token)};
  }
  async revoke(s){await this.pool.query('delete from svitlo_vps.sessions where token_hash=$1',[sha(s.token)]);}
}
