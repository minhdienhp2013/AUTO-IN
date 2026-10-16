import { randomUUID } from 'node:crypto';
import { assertOwner, assertStaff, dbSafeInteger, DomainError, type Principal, type SettingsRow } from './model.js';
import { PgStore } from '../storage/database.js';

export interface ScheduleRow extends SettingsRow {
 schedule_version: string | number;
 schedule_updated_at: Date | null;
 schedule_updated_by: string | null;
}
export interface ScheduleView {
 shop_id: string;
 version: number;
 open_at: string;
 close_at: string;
 timezone: string;
 holiday_dates: string[];
 manual_lock: boolean;
 operational_guard: { mode: SettingsRow['mode']; printing_enabled: boolean };
 changed?: boolean;
}
type ScheduleFields = Pick<SettingsRow,'open_at'|'close_at'|'timezone'|'holiday_dates'|'manual_lock'>;
export interface SchedulePatch {
 expected_version: number;
 idempotency_key: string;
 changes: Partial<ScheduleFields>;
}
const maxVersion = Number.MAX_SAFE_INTEGER;
const allowed = new Set(['open_at','close_at','timezone','holiday_dates','manual_lock']);
const readOnly = new Set(['mode','printing_enabled','operational_guard']);
const own = (v: object, key: string): boolean => Object.prototype.hasOwnProperty.call(v,key);
const bad = (message: string): never => { throw new DomainError('INVALID_SCHEDULE',message,422); };
function validTime(value: unknown, closing: boolean): string {
 if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value) && !(closing&&value==='24:00'))
  return bad('Giờ phải đúng HH:mm; 24:00 chỉ được dùng làm giờ đóng');
 return value;
}
function isLeap(y: number): boolean { return y%4===0 && (y%100!==0||y%400===0); }
function validDate(value: unknown): value is string {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const [y,m,d]=value.split('-').map(Number);
 if(y<1||m<1||m>12||d<1)return false;
 const days=[31,isLeap(y)?29:28,31,30,31,30,31,31,30,31,30,31];
 return d<=days[m-1];
}
function sortedDates(value: unknown): string[] {
 if(!Array.isArray(value)||value.length>730)return bad('Ngày nghỉ phải là mảng tối đa 730 ngày');
 if(value.some(v=>!validDate(v)))return bad('Ngày nghỉ phải là ngày Gregorian YYYY-MM-DD hợp lệ');
 const result=[...value] as string[];
 if(new Set(result).size!==result.length)return bad('Ngày nghỉ bị trùng');
 return result.sort();
}
export function validateSchedulePatch(input: unknown): SchedulePatch {
 if(input===null||typeof input!=='object'||Array.isArray(input))throw new DomainError('INVALID_INPUT','Cần JSON object',422);
 const obj=input as Record<string,unknown>;
 for(const key of Object.keys(obj)) {
  if(readOnly.has(key))throw new DomainError('READ_ONLY_OPERATION_FIELDS','Không được đổi chế độ hoặc quyền in',422);
  if(!allowed.has(key)&&key!=='expected_version'&&key!=='idempotency_key')
   throw new DomainError('INVALID_INPUT','Trường cấu hình không được phép',422);
 }
 if(!Number.isSafeInteger(obj.expected_version)||typeof obj.expected_version!=='number'||obj.expected_version<1)
  return bad('expected_version phải là số nguyên an toàn dương');
 if(typeof obj.idempotency_key!=='string'||!obj.idempotency_key.trim()||obj.idempotency_key.length>128)
  throw new DomainError('IDEMPOTENCY_REQUIRED','Khóa yêu cầu 1–128 ký tự',422);
 const changes: Partial<ScheduleFields>={};
 if(own(obj,'open_at'))changes.open_at=validTime(obj.open_at,false);
 if(own(obj,'close_at'))changes.close_at=validTime(obj.close_at,true);
 if(own(obj,'timezone')){
  if(obj.timezone!=='Asia/Ho_Chi_Minh')return bad('Chỉ hỗ trợ Asia/Ho_Chi_Minh');
  changes.timezone=obj.timezone;
 }
 if(own(obj,'holiday_dates'))changes.holiday_dates=sortedDates(obj.holiday_dates);
 if(own(obj,'manual_lock')){
  if(typeof obj.manual_lock!=='boolean')return bad('manual_lock phải là boolean');
  changes.manual_lock=obj.manual_lock;
 }
 if(Object.keys(changes).length===0)return bad('PATCH phải thay ít nhất một trường hợp lệ');
 return {expected_version:obj.expected_version as number,idempotency_key:obj.idempotency_key,changes};
}
function scheduleFields(row: ScheduleFields): ScheduleFields {
 return {open_at:row.open_at,close_at:row.close_at,timezone:row.timezone,
  holiday_dates:[...row.holiday_dates].sort(),manual_lock:row.manual_lock};
}
function mergedFields(row: ScheduleFields, changes: Partial<ScheduleFields>): ScheduleFields {
 const merged=scheduleFields({...row,...changes});
 validTime(merged.open_at,false);validTime(merged.close_at,true);
 if(merged.open_at>=merged.close_at)return bad('Giờ mở phải nhỏ hơn giờ đóng, không qua đêm');
 if(merged.timezone!=='Asia/Ho_Chi_Minh')return bad('Chỉ hỗ trợ Asia/Ho_Chi_Minh');
 merged.holiday_dates=sortedDates(merged.holiday_dates);
 if(typeof merged.manual_lock!=='boolean')return bad('manual_lock không hợp lệ');
 return merged;
}
function versionOf(row: ScheduleRow): number {
 const v=dbSafeInteger(row.schedule_version,'schedule_version');
 if(v<1)throw new DomainError('SCHEDULE_VERSION_INVALID','Phiên bản lịch không hợp lệ',500);
 return v;
}
function view(row: ScheduleRow, changed?: boolean): ScheduleView {
 return {shop_id:row.shop_id,version:versionOf(row),...scheduleFields(row),
  operational_guard:{mode:row.mode,printing_enabled:row.printing_enabled},
  ...(changed===undefined?{}:{changed})};
}
function rethrowScheduleDb(error: unknown): never {
 if(error instanceof DomainError)throw error;
 const code=(error as {code?: unknown} | null)?.code;
 if(typeof code==='string'&&(/^(08|53|57)/.test(code)||['55P03','42P01','42703','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH'].includes(code)))
  throw new DomainError('SCHEDULE_UNAVAILABLE','Không đọc/ghi được lịch shop; không mở khóa in',503,true);
 throw error;
}
/** Read and update only the caller's authenticated shop. Never mutate operational mode. */
export class ShopScheduleService {
 constructor(private readonly store: PgStore) {}
 async get(p:Principal):Promise<ScheduleView> {
  assertStaff(p);
  try {
   const result=await this.store.pool.query<ScheduleRow>(
    'SELECT * FROM core_shop_settings WHERE shop_id=$1',[p.shop_id]);
   if(!result.rows[0])throw new DomainError('SHOP_SETTINGS_NOT_FOUND','Không tìm thấy cấu hình shop',404);
   return view(result.rows[0]);
  }catch(e){return rethrowScheduleDb(e);}
 }
 async patch(p:Principal,body:unknown):Promise<ScheduleView> {
  assertOwner(p);
  const input=validateSchedulePatch(body); // auth and body validation happen before replay
  try {
   return await this.store.tx(db=>this.store.once(db,p,'shop.schedule.patch',
    input.idempotency_key,body,async()=>{
    const result=await db.query<ScheduleRow>(
     'SELECT * FROM core_shop_settings WHERE shop_id=$1 FOR UPDATE',[p.shop_id]);
    const current=result.rows[0];
    if(!current)throw new DomainError('SHOP_SETTINGS_NOT_FOUND','Không tìm thấy cấu hình shop',404);
    const oldVersion=versionOf(current);
    if(oldVersion!==input.expected_version)
     throw new DomainError('STALE_SETTINGS_VERSION','Lịch đã thay đổi; tải lại trước khi sửa',409);
    const next=mergedFields(current,input.changes);
    const previous=scheduleFields(current);
    if(JSON.stringify(previous)===JSON.stringify(next))return view(current,false);
    if(oldVersion===maxVersion)
     throw new DomainError('SCHEDULE_VERSION_EXHAUSTED','Không thể tăng phiên bản lịch',409);
    const updated=await db.query<ScheduleRow>(
     'UPDATE core_shop_settings SET open_at=$2,close_at=$3,timezone=$4,'+
     'holiday_dates=$5::text[],manual_lock=$6,schedule_version=schedule_version+1,'+
     'schedule_updated_at=now(),schedule_updated_by=$7 '+
     'WHERE shop_id=$1 AND schedule_version=$8 RETURNING *',
     [p.shop_id,next.open_at,next.close_at,next.timezone,next.holiday_dates,
      next.manual_lock,p.id,oldVersion]);
    if(updated.rows.length!==1)
     throw new DomainError('STALE_SETTINGS_VERSION','Lịch đã thay đổi; tải lại trước khi sửa',409);
    await db.query(
     'INSERT INTO core_shop_schedule_audit(id,shop_id,actor_id,old_version,new_version,previous_schedule,next_schedule) '+
     'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
     [randomUUID(),p.shop_id,p.id,oldVersion,oldVersion+1,JSON.stringify(previous),JSON.stringify(next)]);
    return view(updated.rows[0],true);
   }));
  }catch(e){return rethrowScheduleDb(e);}
 }
}
