import {randomUUID} from 'node:crypto';
import {DomainError} from './model.js';
import type {PgStore,SqlConnection} from '../storage/database.js';

const maxGrantSeconds=30*60;
const shopPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const printerPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ticketPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;

export interface ControlledTestGrantInput {
 readonly shop_id:string;
 readonly order_id:string;
 readonly printer_id:string;
 readonly owner_id:string;
 readonly ttl_seconds:number;
 readonly ticket_ref:string;
}
export interface ControlledTestRevokeInput {
 readonly shop_id:string;
 readonly order_id:string;
 readonly printer_id:string;
 readonly ticket_ref:string;
}
export interface ControlledTestGrantResult {
 readonly shop_id:string;
 readonly order_id:string;
 readonly printer_id:string;
 readonly expires_at:string;
}

function validateScope(input:{shop_id:string;order_id:string;printer_id:string;ticket_ref:string}):void{
 if(!shopPattern.test(input.shop_id)||!uuidPattern.test(input.order_id)||
    !printerPattern.test(input.printer_id)||!ticketPattern.test(input.ticket_ref))
  throw new DomainError('CONTROLLED_TEST_GRANT_INPUT_INVALID','Thông tin ticket hoặc scope không hợp lệ',422);
}
function validateOperatorRole(expected:string):void{
 if(!/^[A-Za-z0-9_:-]{1,64}$/.test(expected)||
    ['postgres','root','admin','administrator'].includes(expected.toLowerCase()))
  throw new DomainError('CONTROLLED_TEST_OPERATOR_ROLE_REQUIRED','Cần DB role operator chuyên biệt',503);
}
async function operatorRole(db:SqlConnection,expected:string):Promise<string>{
 const row=(await db.query<{operator_role:string}>('SELECT session_user::text AS operator_role')).rows[0];
 if(!row?.operator_role||row.operator_role!==expected)
  throw new DomainError('CONTROLLED_TEST_OPERATOR_ROLE_MISMATCH','DB role không được phép quản lý controlled_test',403);
 return row.operator_role;
}
async function audit(db:SqlConnection,input:{shop_id:string;order_id:string;actor_id:string;
 action:string;details:Record<string,unknown>}):Promise<void>{
 const result=await db.query(
  'INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
  [randomUUID(),input.shop_id,input.actor_id,input.action,input.order_id,JSON.stringify(input.details)]);
 if(result.rowCount!==1)throw new DomainError('CONTROLLED_TEST_AUDIT_FAILED','Audit grant không được ghi nhận',503);
}

/**
 * Private operator-only provisioning path. It is intentionally not registered
 * as an HTTP route. All authority changes, Core mode changes and audit rows
 * commit or roll back together; expiry is generated only from the DB clock.
 */
export async function issueControlledTestGrant(store:PgStore,input:ControlledTestGrantInput,
 expectedOperatorRole:string):Promise<ControlledTestGrantResult>{
 validateScope(input);validateOperatorRole(expectedOperatorRole);
 if(!uuidPattern.test(input.owner_id)||!Number.isSafeInteger(input.ttl_seconds)||
    input.ttl_seconds<1||input.ttl_seconds>maxGrantSeconds)
  throw new DomainError('CONTROLLED_TEST_GRANT_INPUT_INVALID','TTL tối đa 30 phút và owner ID phải hợp lệ',422);
 return store.tx(async db=>{
  const operator=await operatorRole(db,expectedOperatorRole);
  const target=(await db.query<{shop_id:string;mode:string;printing_enabled:boolean;shop_manual_lock:boolean;
    order_id:string;active_revision:number;manual_lock:boolean;print_closed:boolean;
    owner_id:string;owner_role:string;owner_active:boolean}>(
   `SELECT ss.shop_id,ss.mode,ss.printing_enabled,ss.manual_lock AS shop_manual_lock,
    o.id AS order_id,o.active_revision,
    o.manual_lock,o.print_closed,u.id::text AS owner_id,u.role AS owner_role,u.active AS owner_active
    FROM core_shop_settings ss JOIN core_orders o ON o.shop_id=ss.shop_id AND o.id=$2
    JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision
    JOIN core_users u ON u.id=$3::uuid AND u.shop_id=ss.shop_id
    WHERE ss.shop_id=$1 FOR UPDATE OF ss,o,u`,
   [input.shop_id,input.order_id,input.owner_id])).rows;
  const row=target[0];
  if(target.length!==1||!row||row.owner_id!==input.owner_id||row.owner_role!=='owner'||!row.owner_active||
     row.order_id!==input.order_id||row.mode!=='simulation'||row.printing_enabled!==false||row.shop_manual_lock||
     row.manual_lock||row.print_closed)
   throw new DomainError('CONTROLLED_TEST_GRANT_SCOPE_REQUIRED','Cần order hiện hành và owner active đúng shop; shop phải đang OFF',409);
  const active=(await db.query<{order_id:string;printer_id:string}>(
   'SELECT order_id,printer_id FROM core_print_controlled_test_scopes '+
   'WHERE shop_id=$1 AND enabled AND expires_at>clock_timestamp() FOR UPDATE',[input.shop_id])).rows;
  if(active.length)
   throw new DomainError('CONTROLLED_TEST_GRANT_ALREADY_ACTIVE','Shop đã có grant controlled_test còn hạn',409);
  const mode=await db.query<{shop_id:string}>(
   "UPDATE core_shop_settings SET mode='controlled_test',printing_enabled=true "+
   "WHERE shop_id=$1 AND mode='simulation' AND NOT printing_enabled RETURNING shop_id",[input.shop_id]);
  if(mode.rowCount!==1)
   throw new DomainError('CONTROLLED_TEST_MODE_UPDATE_FAILED','Không thể bật đúng shop trong transaction',409);
  const grant=await db.query<ControlledTestGrantResult>(
   `WITH issue_clock AS (SELECT clock_timestamp() AS issued_at)
    INSERT INTO core_print_controlled_test_scopes
     (shop_id,order_id,printer_id,enabled,expires_at,configured_by,updated_at)
    SELECT $1,$2::uuid,$3,true,issue_clock.issued_at+($5::int*interval '1 second'),$4::uuid,
     issue_clock.issued_at FROM issue_clock
    ON CONFLICT(shop_id,order_id,printer_id) DO UPDATE
     SET enabled=true,expires_at=EXCLUDED.expires_at,configured_by=EXCLUDED.configured_by,
      updated_at=EXCLUDED.updated_at
     WHERE NOT core_print_controlled_test_scopes.enabled OR
      core_print_controlled_test_scopes.expires_at<=clock_timestamp()
    RETURNING shop_id,order_id,printer_id,expires_at`,
   [input.shop_id,input.order_id,input.printer_id,input.owner_id,input.ttl_seconds]);
  if(grant.rowCount!==1||grant.rows.length!==1)
   throw new DomainError('CONTROLLED_TEST_GRANT_WRITE_FAILED','Không ghi được đúng một grant',409);
  const result=grant.rows[0]!;
  await audit(db,{shop_id:input.shop_id,order_id:input.order_id,actor_id:input.owner_id,
   action:'controlled_test.scope.granted',details:{printer_id:input.printer_id,
    expires_at:result.expires_at,ttl_seconds:input.ttl_seconds,ticket_ref:input.ticket_ref,
    operator_db_role:operator}});
  return result;
 });
}

/** Revoke is available to the trusted operator even if the grantor owner is now inactive. */
export async function revokeControlledTestGrant(store:PgStore,input:ControlledTestRevokeInput,
 expectedOperatorRole:string):Promise<void>{
 validateScope(input);validateOperatorRole(expectedOperatorRole);
 await store.tx(async db=>{
  const operator=await operatorRole(db,expectedOperatorRole);
  const locked=await db.query<{shop_id:string;order_id:string;mode:string}>(
   `SELECT ss.shop_id,o.id AS order_id,ss.mode FROM core_shop_settings ss
    JOIN core_orders o ON o.shop_id=ss.shop_id AND o.id=$2
    WHERE ss.shop_id=$1 FOR UPDATE OF ss,o`,[input.shop_id,input.order_id]);
  if(locked.rowCount!==1||locked.rows[0]?.order_id!==input.order_id)
   throw new DomainError('CONTROLLED_TEST_GRANT_SCOPE_REQUIRED','Shop/order không khớp',409);
  const removed=await db.query<{configured_by:string}>(
   `UPDATE core_print_controlled_test_scopes SET enabled=false,
    expires_at=LEAST(expires_at,clock_timestamp()),updated_at=clock_timestamp()
    WHERE shop_id=$1 AND order_id=$2::uuid AND printer_id=$3 AND enabled
    RETURNING configured_by::text AS configured_by`,
   [input.shop_id,input.order_id,input.printer_id]);
  if(removed.rowCount!==1||removed.rows.length!==1)
   throw new DomainError('CONTROLLED_TEST_GRANT_NOT_ACTIVE','Không có grant đang bật đúng scope',409);
  const remaining=await db.query<{order_id:string}>(
   'SELECT order_id FROM core_print_controlled_test_scopes WHERE shop_id=$1 AND enabled '+
    'AND expires_at>clock_timestamp() FOR UPDATE',[input.shop_id]);
  let mode='unchanged';
  if(remaining.rows.length===0&&locked.rows[0]?.mode==='controlled_test'){
   const safe=await db.query<{shop_id:string}>(
    "UPDATE core_shop_settings SET mode='simulation',printing_enabled=false "+
    "WHERE shop_id=$1 AND mode='controlled_test' RETURNING shop_id",[input.shop_id]);
   if(safe.rowCount!==1)
    throw new DomainError('CONTROLLED_TEST_MODE_UPDATE_FAILED','Không thể tắt đúng shop trong transaction',409);
   mode='simulation_off';
  }
  await audit(db,{shop_id:input.shop_id,order_id:input.order_id,actor_id:operator,
   action:'controlled_test.scope.revoked',details:{printer_id:input.printer_id,
    ticket_ref:input.ticket_ref,operator_db_role:operator,remaining_active_scopes:remaining.rows.length,
    shop_mode:mode}});
 });
}
