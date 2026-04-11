// Partee Golf — Service Worker for Push Notifications
self.addEventListener('push', function(event) {
  let data = { title: 'Partee Golf', body: 'Tienes una nueva notificación', icon: '⛳' };
  try { data = event.data.json(); } catch(e) {}
  
  const options = {
    body: data.body || '',
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    data: data.url || '/',
    vibrate: [200, 100, 200],
    tag: data.tag || 'partee-notification',
    renotify: true,
    actions: data.actions || []
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title || 'Partee Golf', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (const client of clientList) {
        if (client.url.includes('partee.com.mx') && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
