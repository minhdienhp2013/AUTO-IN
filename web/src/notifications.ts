/** Browser-only adapter; NOT a claim of Zalo OA/Web Push deployment. */
export type NotificationCapability = 'unsupported' | 'needs-permission' | 'permission-denied' | 'granted-no-subscription' | 'permission-error';

/** A granted browser permission is NOT a connected Web Push subscription. */
export function notificationCapability(): NotificationCapability {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) ||
      globalThis.isSecureContext !== true || typeof globalThis.Notification === 'undefined' ||
      typeof globalThis.Notification.requestPermission !== 'function') return 'unsupported';
  switch (globalThis.Notification.permission) {
    case 'denied': return 'permission-denied';
    case 'default': return 'needs-permission';
    case 'granted': return 'granted-no-subscription';
    default: return 'unsupported'; // Do not interpret unexpected states as granted.
  }
}

/** Only call on a deliberate button click; rejected prompts never escape. */
export async function requestLocalNotifications(): Promise<NotificationCapability> {
  const before = notificationCapability();
  if (before !== 'needs-permission') return before;
  try {
    await globalThis.Notification.requestPermission();
  } catch {
    // Browser/OS can change the permission while an async prompt is pending.
    // If it is still askable, show a recoverable error; otherwise show the
    // actual denied/granted/unsupported state instead of requesting again.
    const after = notificationCapability();
    return after === 'needs-permission' ? 'permission-error' : after;
  }
  return notificationCapability();
}

export function orderFromNavigation(search: string): { id: string | null; revision: number | null } {
  const qs = new URLSearchParams(search);
  const id = qs.get('order_id');
  const rev = Number(qs.get('revision'));
  return { id: id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null, revision: Number.isSafeInteger(rev) && rev > 0 ? rev : null };
}
