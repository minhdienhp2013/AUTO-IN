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

function sameScope(left: SessionRequestScope, right: SessionRequestScope): boolean {
  return left.epoch === right.epoch &&
    left.sessionVersion === right.sessionVersion &&
    left.actorId === right.actorId &&
    left.role === right.role &&
    left.shopId === right.shopId;
}

/** Resolve a request only while its exact UI session, shop, and request epoch remain active. */
export async function resolveForSession<T>(
  request: Promise<T>,
  expected: SessionRequestScope,
  currentScope: () => SessionRequestScope,
): Promise<SessionRequestResult<T>> {
  const value = await request;
  return sameScope(expected, currentScope()) ? { current: true, value } : { current: false };
}
