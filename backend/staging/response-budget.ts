export const STAGING_RESPONSE_BUDGET_MS = 1500;

export type StagingBudgetResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'deadline' };

/** Bounds the HTTP response even if a local dependency stalls. This does not
 * cancel the database operation; callers must use idempotent event keys and
 * the database timeouts below. A timed-out operation may still commit later.
 */
export async function withinStagingResponseBudget<T>(
  operation: Promise<T>,
  budgetMs = STAGING_RESPONSE_BUDGET_MS
): Promise<StagingBudgetResult<T>> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > STAGING_RESPONSE_BUDGET_MS)
    throw new Error('INVALID_STAGING_RESPONSE_BUDGET');

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(value => ({ kind: 'completed' as const, value })),
      new Promise<StagingBudgetResult<T>>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'deadline' }), budgetMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
