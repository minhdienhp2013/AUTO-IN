/** At most two retries after initial download, then HUMAN review; never drop the event. */
export async function downloadWithRetry<T>(
  fetchFile: () => Promise<T>,
  onFailedAttempt: (attempt: number, error: unknown) => Promise<void> = async () => {},
): Promise<{ status: "ok"; data: T; attempts: number } | { status: "needs_human"; attempts: 3 }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await fetchFile();
      return { status: "ok", data, attempts: attempt };
    } catch (error) {
      await onFailedAttempt(attempt, error);
    }
  }
  return { status: "needs_human", attempts: 3 };
}
