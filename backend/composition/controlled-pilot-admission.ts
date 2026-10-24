import {DomainError, type Principal} from '../core/model.js';
import type {SqlPool} from '../storage/database.js';

export interface ControlledPilotScope {
  shop_id: string;
  order_id: string;
  printer_id: string;
}

/** The composition boundary admits only one server-configured pilot order.
 * Core independently rechecks the owner grant, active revision and lease.
 * Report remains available after a grant expires so an uncertain send can be
 * reconciled; it never causes a second send.
 */
export async function admitAgentRoute(input: {
  pool: SqlPool;
  agent: Principal;
  pilotRoute: boolean;
  reportRoute?: boolean;
  scope?: ControlledPilotScope;
  jobId?: string;
  requestedPrinterId?: unknown;
}): Promise<void> {
  const settings = await input.pool.query<{mode:string}>(
    'SELECT mode FROM core_shop_settings WHERE shop_id=$1', [input.agent.shop_id]);
  if (settings.rows.length !== 1) throw new DomainError('SIMULATION_REQUIRED','Shop mode unavailable',409);
  const controlled=input.scope;
  if (input.pilotRoute && controlled &&
      (settings.rows[0]?.mode === 'controlled_test' || input.reportRoute === true)) {
    if (input.agent.shop_id !== controlled.shop_id ||
        !input.agent.printer_ids?.includes(controlled.printer_id))
      throw new DomainError('CONTROLLED_PILOT_SCOPE','Pilot scope denied',403);
    if (input.jobId) {
      const rows = await input.pool.query<{order_id:string;printer_id:string;mode_at_send:string|null;state:string}>(
        'SELECT j.order_id,j.printer_id,j.mode_at_send,j.state FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id '+
        'WHERE j.id=$1 AND o.shop_id=$2 AND j.pilot_authorization_id IS NOT NULL AND j.approval_id IS NULL',
        [input.jobId,controlled.shop_id]);
      if (rows.rows.length !== 1 || rows.rows[0]?.order_id !== controlled.order_id ||
          rows.rows[0]?.printer_id !== controlled.printer_id ||
          (input.reportRoute === true && (rows.rows[0]?.mode_at_send !== 'controlled_test' ||
            !['SENDING','UNKNOWN','SENT_UNVERIFIED'].includes(rows.rows[0]?.state ?? ''))))
        throw new DomainError('CONTROLLED_PILOT_SCOPE','Pilot scope denied',403);
    } else if (input.requestedPrinterId !== controlled.printer_id) {
      throw new DomainError('CONTROLLED_PILOT_SCOPE','Pilot scope denied',403);
    }
    return;
  }
  // The controlled server never exposes legacy Agent send routes. A normal
  // simulation server never permits a real-mode shop to send.
  if (settings.rows[0]?.mode !== 'simulation' || controlled)
    throw new DomainError('SIMULATION_REQUIRED','Simulation shop required',409);
}
