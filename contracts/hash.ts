import { createHash } from 'node:crypto';
import { valid } from './validation.js';
import type { Manifest } from './schemas.js';

/** Canonical JSON v0.1: UTF-16 key sort, array order preserved, JSON number encoding.
 * Only finite numbers, strings, booleans, null, dense arrays and plain objects.
 * No Unicode normalization: document bytes/content must remain exact.
 */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function encode(v: unknown): string {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null) throw new TypeError('Non-JSON value');
    if (active.has(v)) throw new TypeError('Cyclic JSON');
    active.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new TypeError('Sparse or extended array');
        return '[' + Array.from(v, encode).join(',') + ']';
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new TypeError('Expected plain JSON object');
      }
      if (Object.getOwnPropertySymbols(v).length) throw new TypeError('Symbol keys');
      return '{' + Object.keys(v).sort().map(k => {
        const descriptor = Object.getOwnPropertyDescriptor(v, k)!;
        if (!('value' in descriptor)) throw new TypeError('Accessor property');
        return JSON.stringify(k) + ':' + encode(descriptor.value);
      }).join(',') + '}';
    } finally { active.delete(v); }
  }
  return encode(value);
}
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
/** Hash a validated RequestManifest only. Excludes revision, actor, status and time. */
export function requestHash(manifest: Manifest): string {
  if (!valid('RequestManifest', manifest)) throw new TypeError('Invalid RequestManifest');
  return payloadHash(manifest);
}
export function idempotencyScope(actorId: string, action: string, key: string): string {
  return payloadHash({ actor_id: actorId, action, idempotency_key: key });
}
