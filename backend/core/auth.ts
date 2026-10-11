import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError, newId, type Principal, type Role } from './model.js';
import type { PgStore } from '../storage/database.js';
const scrypt=promisify(scryptCallback);
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
export async function passwordHash(password:string):Promise<string> {
 if (password.length < 12) throw new DomainError('WEAK_PASSWORD','Mật khẩu phải dài ít nhất 12 ký tự');
 const salt=randomBytes(16).toString('hex');const derived=await scrypt(password,salt,64) as Buffer;
 return `scrypt:${salt}:${derived.toString('hex')}`;
}
export async function passwordVerify(password:string,stored:string):Promise<boolean>{
 const [scheme,salt,hex]=stored.split(':'); if (scheme!=='scrypt'||!salt||!hex||hex.length!==128) return false;
 const actual=await scrypt(password,salt,64) as Buffer;const expected=Buffer.from(hex,'hex');return expected.length===actual.length && timingSafeEqual(actual,expected);
}
export class AuthService {
 constructor(private readonly store:PgStore){}
 // Explicit one-time, locally invoked bootstrap. No HTTP bootstrap endpoint, no default password.
 async bootstrapOwner(config:{shop_id:string;username:string;password:string;bootstrap_enabled:boolean}):Promise<string>{
  if(!config.bootstrap_enabled) throw new DomainError('BOOTSTRAP_DISABLED','Cần bật bootstrap ngoài mã nguồn',403);
  return this.store.tx(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[config.shop_id]);
   const existing=await db.query('SELECT id FROM core_users WHERE shop_id=$1 LIMIT 1',[config.shop_id]);
   if(existing.rows.length) throw new DomainError('BOOTSTRAP_EXISTS','Cửa hàng đã có tài khoản',409);
   const id=newId(),hash=await passwordHash(config.password);
   await db.query('INSERT INTO core_shop_settings(shop_id) VALUES($1) ON CONFLICT DO NOTHING',[config.shop_id]);
   await db.query('INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES ($1,$2,$3,$4,$5)',[id,config.shop_id,config.username,hash,'owner']);
   return id;
  });
 }
 async login(shop_id:string,username:string,password:string):Promise<{token:string;principal:Principal}>{
  const data=await this.store.pool.query<{id:string;shop_id:string;role:Role;password_hash:string;active:boolean}>('SELECT id,shop_id,role,password_hash,active FROM core_users WHERE shop_id=$1 AND username=$2',[shop_id,username]);
  const user=data.rows[0];if(!user||!user.active||!(await passwordVerify(password,user.password_hash))) throw new DomainError('INVALID_CREDENTIALS','Tài khoản hoặc mật khẩu không đúng',401);
  const token=randomBytes(32).toString('base64url');await this.store.pool.query('INSERT INTO core_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval \'12 hours\')',[newId(),user.id,digest(token)]);
  return {token,principal:{id:user.id,shop_id:user.shop_id,role:user.role,verified:true}};
 }
 async principal(token:string):Promise<Principal>{
  if (!token || token.length>512) throw new DomainError('UNAUTHENTICATED','Thiếu phiên',401);
  const res=await this.store.pool.query<{id:string;shop_id:string;role:Role}>('SELECT u.id,u.shop_id,u.role FROM core_sessions s JOIN core_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active=true',[digest(token)]);
  if(!res.rows[0]) throw new DomainError('UNAUTHENTICATED','Phiên hết hạn hoặc không hợp lệ',401);
  return {...res.rows[0],verified:true};
 }
 async logout(token:string):Promise<void>{ if(token) await this.store.pool.query('UPDATE core_sessions SET revoked_at=now() WHERE token_hash=$1',[digest(token)]); }
}
