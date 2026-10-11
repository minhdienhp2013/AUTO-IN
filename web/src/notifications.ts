/** Browser-only adapter; NOT a claim of Zalo OA/Web Push deployment. */
export type NotificationCapability = 'unsupported' | 'needs-permission' | 'permission-denied' | 'granted-no-subscription';
export function notificationCapability(): NotificationCapability {
  if (!('Notification' in globalThis) || !('serviceWorker' in navigator) || !isSecureContext) return 'unsupported';
  if (Notification.permission === 'denied') return 'permission-denied';
  if (Notification.permission === 'default') return 'needs-permission';
  return 'granted-no-subscription';
}
export async function requestLocalNotifications(): Promise<NotificationCapability> {
  if (notificationCapability() !== 'needs-permission') return notificationCapability();
  await Notification.requestPermission();
  return notificationCapability();
}
export function orderFromNavigation(search: string): { id: string | null; revision: number | null } {
  const qs = new URLSearchParams(search);
  const id = qs.get('order_id');
  const rev = Number(qs.get('revision'));
  return { id: id && /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : null, revision: Number.isSafeInteger(rev) && rev > 0 ? rev : null };
}