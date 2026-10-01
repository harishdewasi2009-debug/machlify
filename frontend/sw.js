// Matchify service worker — handles Web Push only (no offline caching).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Matchify';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'You have a new notification.',
    icon: '/icon-192.png',
    data: data.data || {},
    tag: data.data && data.data.matchId ? 'match-' + data.data.matchId : undefined,
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('/');
  }));
});
