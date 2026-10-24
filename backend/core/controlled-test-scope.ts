import {DomainError, type Mode} from './model.js';
import type {SqlConnection} from '../storage/database.js';

export interface ControlledTestScope {
 readonly shop_id:string;
 readonly order_id:string;
 readonly printer_id:string;
}

interface ScopeRow extends ControlledTestScope {
 enabled:boolean;
 active:boolean;
 duration_valid:boolean;
 order_shop_id:string;
 configured_by_role:string;
 configured_by_active:boolean;
}

/**
 * A controlled-test grant is an operator-configured, expiring tuple. The Core
 * order row is joined again so a mismatched shop/order pair cannot grant scope.
 */
export async function hasControlledTestScope(db:SqlConnection,scope:ControlledTestScope,lock=false):Promise<boolean>{
 let row:ScopeRow|undefined;
 try{
  row=(await db.query<ScopeRow>(
   'SELECT s.shop_id,s.order_id,s.printer_id,s.enabled,(s.expires_at>clock_timestamp()) AS active,'+
   '(s.updated_at<=clock_timestamp() AND s.expires_at<=s.updated_at+interval \'30 minutes\') AS duration_valid,'+
   'o.shop_id AS order_shop_id,u.role AS configured_by_role,u.active AS configured_by_active '+
   'FROM core_print_controlled_test_scopes s JOIN core_orders o ON o.id=s.order_id '+
   'JOIN core_users u ON u.id=s.configured_by AND u.shop_id=s.shop_id '+
   'WHERE s.shop_id=$1 AND s.order_id=$2 AND s.printer_id=$3'+
   (lock?' FOR UPDATE OF s,u':''),[scope.shop_id,scope.order_id,scope.printer_id])).rows[0];
 }catch{
  throw new DomainError('CONTROLLED_TEST_SCOPE_UNAVAILABLE','Không thể xác minh cấu hình controlled_test',503,true);
 }
 return Boolean(row&&row.shop_id===scope.shop_id&&row.order_id===scope.order_id&&
  row.printer_id===scope.printer_id&&row.order_shop_id===scope.shop_id&&row.enabled===true&&row.active===true&&
  row.duration_valid===true&&
  row.configured_by_role==='owner'&&row.configured_by_active===true);
}

export async function requireControlledTestScope(db:SqlConnection,scope:ControlledTestScope):Promise<void>{
 if(!await hasControlledTestScope(db,scope,true))
  throw new DomainError('CONTROLLED_TEST_SCOPE_REQUIRED','Controlled_test cần cấu hình đang bật đúng shop/đơn/máy in',409);
}

export async function enforceModeScope(db:SqlConnection,mode:Mode,scope:ControlledTestScope):Promise<void>{
 if(mode==='controlled_test')await requireControlledTestScope(db,scope);
}

/** SQL predicate for queue selection: an unscoped test order must not block a later scoped job. */
export function controlledTestScopeExistsSql(alias='j'):string{
 if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw new DomainError('INVALID_INPUT','Alias SQL không hợp lệ',500);
 return 'EXISTS (SELECT 1 FROM core_print_controlled_test_scopes c '+
  'JOIN core_orders co ON co.id=c.order_id AND co.shop_id=c.shop_id '+
  "JOIN core_users cu ON cu.id=c.configured_by AND cu.shop_id=c.shop_id AND cu.role='owner' AND cu.active "+
  `WHERE c.shop_id=o.shop_id AND c.order_id=o.id AND c.printer_id=${alias}.printer_id `+
  'AND c.enabled AND c.expires_at>clock_timestamp() '+
  'AND c.updated_at<=clock_timestamp() AND c.expires_at<=c.updated_at+interval \'30 minutes\')';
}
