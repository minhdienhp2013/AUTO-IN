export interface SessionRequestScope {
  readonly epoch: number;
  readonly sessionVersion: number;
  readonly actorId: string | null;
  readonly role: string | null;
  readonly shopId: string | null;
}

export type SessionRequestResult<T> =
  | { readonly current: true; readonly value: T }
  | { readonly current: false };

export function sameSessionGeneration(left: SessionRequestScope, right: SessionRequestScope): boolean {
  return left.epoch === right.epoch &&
    left.sessionVersion === right.sessionVersion &&
    left.actorId === right.actorId &&
    left.role === right.role;
}

export function sameRequestScope(left: SessionRequestScope, right: SessionRequestScope): boolean {
  return sameSessionGeneration(left, right) && left.shopId === right.shopId;
}

export type SessionFailureDisposition = 'unauthorized' | 'current-error' | 'stale';

/** A current 401 may have already cleared the API shop ID; stale requests must be ignored. */
export function classifySessionFailure(
  status: number,
  expected: SessionRequestScope,
  current: SessionRequestScope,
): SessionFailureDisposition {
  if (status === 401) return sameSessionGeneration(expected, current) ? 'unauthorized' : 'stale';
  return sameRequestScope(expected, current) ? 'current-error' : 'stale';
}

/** Resolve a request only while its exact UI session, shop, and request epoch remain active. */
export async function resolveForSession<T>(
  request: Promise<T>,
  expected: SessionRequestScope,
  currentScope: () => SessionRequestScope,
): Promise<SessionRequestResult<T>> {
  const value = await request;
  return sameRequestScope(expected, currentScope()) ? { current: true, value } : { current: false };
}
