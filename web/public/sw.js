// TN-008: no push subscription is created until backend/security integration is verified.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let message;
    try { message = event.data.json(); } catch { return; }
    // Do not show sensitive customer content from unauthenticated push payloads.
    const id = typeof message.order_id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(message.order_id)
      ? message.order_id : null;
    if (!id) return;
    const urgent = message.urgent === true;
    const destination = new URL('/', self.location.origin);
    destination.searchParams.set('order_id', id);
    if (Number.isSafeInteger(message.revision) && message.revision > 0) {
      destination.searchParams.set('revision', String(message.revision));
    }
    await self.registration.showNotification(urgent ? 'AUTO-IN · Cần xử lý khẩn' : 'AUTO-IN · Có đơn cần kiểm tra', {
      body: 'Mở ứng dụng để kiểm tra theo quyền tài khoản.',
      tag: `${id}:${message.revision ?? ''}`,
      data: { url: destination.href },
      requireInteraction: urgent,
    });
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (!url) return;
  const target = new URL(url);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === target.origin) {
        await client.navigate(target.href);
        return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});