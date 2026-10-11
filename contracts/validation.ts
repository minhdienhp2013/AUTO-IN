import AjvModule from 'ajv';
import formatsModule from 'ajv-formats';
import { schemas, type SchemaName, type WireInput } from './schemas.js';
const Ajv = AjvModule.default ?? AjvModule;
const formats = formatsModule.default ?? formatsModule;
const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, strictRequired: false, strictTypes: false });
formats(ajv);
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
export function valid<N extends SchemaName>(name: N, value: unknown): value is WireInput<N> {
  return validators[name]!(value) as boolean;
}
/** Cross-field checks omitted from JSON shape are enforced here and by consumers. */
export function validJob(value: unknown): boolean {
  if (!valid('PrintJob', value)) return false;
  if (value.state === 'SIMULATED_DONE') return value.mode === 'simulation' && value.evidence?.evidence_kind === 'simulated';
  if (value.state === 'VERIFIED_DONE') return (value.mode === 'controlled_test' || value.mode === 'production') &&
    (value.evidence?.evidence_kind === 'staff_verified' || value.evidence?.evidence_kind === 'device_verified') &&
    value.evidence.verified_sheets === value.counts.physical_sheets;
  if (value.mode === 'simulation' && value.evidence && value.evidence.evidence_kind !== 'simulated' && value.evidence.evidence_kind !== 'ambiguous') return false;
  return true;
}
