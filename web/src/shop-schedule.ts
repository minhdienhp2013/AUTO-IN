/** CODE501/AI4 staff shop schedule UI contract. No control over AI or print mode. */
export interface ShopSchedule {
  shop_id:string; version:number; open_at:string; close_at:string;
  timezone:'Asia/Ho_Chi_Minh'; holiday_dates:string[]; manual_lock:boolean;
  operational_guard:{mode:'simulation'|'controlled_test'|'production'|'safe';printing_enabled:boolean};
}
export interface ScheduleDraft {open_at:string;close_at:string;holiday_dates:string;manual_lock:boolean}
export interface SchedulePatch {
  expected_version:number;idempotency_key:string;
  open_at?:string;close_at?:string;holiday_dates?:string[];manual_lock?:boolean;
}
export interface SchedulePort {
  getShopSchedule():Promise<ShopSchedule>;
  patchShopSchedule(change:SchedulePatch):Promise<ShopSchedule>;
}
export interface ScheduleSaveResult {
  kind:'unchanged'|'saved'|'failed';
  fresh:ShopSchedule|null;
  failure:unknown|null;
  readbackFailed:boolean;
}
const record=(v:unknown):Record<string,unknown>|null=>
  v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const validTime=(value:unknown,closing=false):value is string=>
  typeof value==='string'&&(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)||(closing&&value==='24:00'));
const dateValid=(v:unknown):v is string=>{
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;
  const [y,m,d]=v.split('-').map(Number);
  if(!y||!m||m>12||!d)return false;
  const leap=y%4===0&&(y%100!==0||y%400===0);
  return d<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1]!;
};
function parseDates(v:unknown):string[]{
  if(!Array.isArray(v)||v.length>730||v.some(d=>!dateValid(d))||
     new Set(v).size!==v.length)throw Error('Danh sách ngày nghỉ không hợp lệ.');
  return [...v].sort() as string[];
}
export function parseShopSchedule(input:unknown):ShopSchedule {
  const o=record(input),guard=record(o?.operational_guard);
  const version=o?.version;
  if(!o||typeof o.shop_id!=='string'||!o.shop_id||
     typeof version!=='number'||!Number.isSafeInteger(version)||version<1||
     !validTime(o.open_at)||!validTime(o.close_at,true)||o.open_at>=o.close_at||
     o.timezone!=='Asia/Ho_Chi_Minh'||typeof o.manual_lock!=='boolean'||
     !guard||!['simulation','controlled_test','production','safe'].includes(String(guard.mode))||
     typeof guard.printing_enabled!=='boolean')
    throw Error('API lịch trả dữ liệu không hợp lệ; thao tác đã khóa.');
  const dates=parseDates(o.holiday_dates);
  return {shop_id:o.shop_id,version,open_at:o.open_at,close_at:o.close_at,
    timezone:'Asia/Ho_Chi_Minh',holiday_dates:dates,manual_lock:o.manual_lock,
    operational_guard:{mode:guard.mode as ShopSchedule['operational_guard']['mode'],
      printing_enabled:guard.printing_enabled}};
}
export function draftFromSchedule(s:ShopSchedule):ScheduleDraft {
  return {open_at:s.open_at,close_at:s.close_at,holiday_dates:s.holiday_dates.join(', '),
    manual_lock:s.manual_lock};
}
export function canEditShopSchedule(role:'owner'|'staff'|null|undefined,allowed:boolean):boolean {
  return role==='owner'&&allowed===true;
}
export function prepareSchedulePatch(s:ShopSchedule,draft:ScheduleDraft,key:string):SchedulePatch|null {
  if(!Number.isSafeInteger(s.version)||s.version<1||
     typeof key!=='string'||key.length<1||key.length>128)
    throw Error('Phiên bản lịch hoặc khóa yêu cầu không hợp lệ.');
  if(!validTime(draft.open_at)||!validTime(draft.close_at,true)||
     draft.open_at>=draft.close_at)
    throw Error('Giờ mở phải trước giờ đóng, đúng HH:mm và không qua đêm.');
  if(typeof draft.manual_lock!=='boolean')throw Error('Trạng thái khóa in không hợp lệ.');
  const text=draft.holiday_dates.trim();
  const dates=parseDates(text?text.split(/[,;\s]+/).filter(Boolean):[]);
  const patch:SchedulePatch={expected_version:s.version,idempotency_key:key};
  if(draft.open_at!==s.open_at)patch.open_at=draft.open_at;
  if(draft.close_at!==s.close_at)patch.close_at=draft.close_at;
  if(JSON.stringify(dates)!==JSON.stringify(s.holiday_dates))patch.holiday_dates=dates;
  if(draft.manual_lock!==s.manual_lock)patch.manual_lock=draft.manual_lock;
  return Object.keys(patch).length===2?null:patch;
}
/** POST/PATCH is NEVER retried after an uncertain response; GET is mandatory. */
export async function saveShopScheduleAndRead(port:SchedulePort,snapshot:ShopSchedule,
  draft:ScheduleDraft,key:string):Promise<ScheduleSaveResult>{
  const change=prepareSchedulePatch(snapshot,draft,key);
  if(!change)return {kind:'unchanged',fresh:snapshot,failure:null,readbackFailed:false};
  let failure:unknown=null;
  try{
    const receipt=await port.patchShopSchedule(change);
    if(receipt.shop_id!==snapshot.shop_id)throw Error('Shop lịch phản hồi không khớp.');
  }catch(e){failure=e;}
  let fresh:ShopSchedule|null=null,readbackFailed=false;
  try{
    fresh=await port.getShopSchedule();
    if(fresh.shop_id!==snapshot.shop_id)throw Error('Shop lịch đọc lại không khớp.');
  }catch(e){readbackFailed=true;fresh=null;if(!failure)failure=e;}
  return {kind:failure?'failed':'saved',fresh,failure,readbackFailed};
}
/** Do not echo arbitrary HTTP error text or database details into the UI. */
export function scheduleErrorText(e:unknown):string {
  const status=record(e)?.status;
  if(status===401)return 'Phiên đăng nhập hết hạn. Hãy đăng nhập lại trước khi đọc hoặc sửa lịch.';
  if(status===403)return 'Bạn không có quyền cập nhật lịch shop. Chỉ chủ cửa hàng được sửa.';
  if(status===409)return 'Lịch đã thay đổi hoặc khóa yêu cầu xung đột. Kiểm tra bản mới rồi tải lại; không tự gửi lại.';
  if(status===503)return 'API lịch hiện không khả dụng. Không xác nhận lưu thành công; hãy tải lại.';
  if(status===0)return 'Mất kết nối API. Chưa xác định thay đổi đã được ghi hay chưa; cần tải lại.';
  if(status===422)return 'Dữ liệu lịch không được máy chủ chấp nhận. Không ghi thay đổi.';
  return 'Không xác minh được lịch shop. Thao tác sửa đã tạm khóa.';
}
