// Partee Service Worker v19.3 (may/2026)
//
// Cambios vs v16:
//   - CACHE_NAME bumpeado: 'partee-v19.3'. Al activar, borra todos los caches anteriores.
//   - HTML / navegación → network-first con timeout 3s + fetch({cache:'no-cache'}).
//     Esto evita servir HTML viejo del HTTP cache del browser entre deploys.
//   - HTML ya NO se precachea en 'install'. Se cachea on-demand, así el primer
//     load siempre es fresh (la cache solo sirve como fallback offline).
//   - Storage de Supabase (fotos de campos) → cache-first explícito.
//   - Soporte para mensaje 'SKIP_WAITING' desde el HTML (compat con auto-update).
//
// Estrategia por tipo de recurso:
//   HTML / navegación              → network-first 3s timeout, fallback cache
//   Assets propios (css, js, img)  → network-first 5s timeout, fallback cache
//   CDN (React, Babel, fonts)      → cache-first (URLs versionadas, inmutables)
//   Storage Supabase (fotos)       → cache-first (cambian raramente)
//   API (Supabase, Stripe, Google) → network-only (no interceptar)

const VERSION = '19.3';
const CACHE_NAME = `partee-v${VERSION}`;
const HTML_TIMEOUT_MS = 3000;
const ASSET_TIMEOUT_MS = 5000;

// Solo assets de baja rotación que conviene precachear para offline.
// HTML NO se precachea — siempre se busca en red primero.
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon.png',
  '/apple-touch-icon.png'
];

const CDN_ASSETS = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.24.7/babel.min.js',
  'https://js.stripe.com/v3/'
];

// ─── Install: precache assets estáticos (NO HTML) ────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW v19.3] precache parcial:', err);
      });
    })
  );
  self.skipWaiting();
});

// ─── Activate: limpiar TODOS los caches que no sean el actual ────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log(`[SW v19.3] borrando cache vieja: ${k}`);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isHTMLRequest(req) {
  return req.mode === 'navigate' ||
         req.destination === 'document' ||
         (req.headers.get('accept') || '').includes('text/html');
}

function isAPIRequest(url) {
  // Supabase REST/RPC, auth, realtime — NO el storage (eso lo manejamos aparte)
  if (url.hostname.includes('supabase.co') && !url.pathname.includes('/storage/v1/object/')) {
    return true;
  }
  return url.hostname.includes('stripe.com') ||
         url.hostname.includes('googleapis.com/auth');
}

function isStorageRequest(url) {
  return url.hostname.includes('supabase.co') && url.pathname.includes('/storage/v1/object/');
}

function isCDNAsset(url) {
  return url.hostname.includes('cdnjs.cloudflare.com') ||
         url.hostname.includes('fonts.googleapis.com') ||
         url.hostname.includes('fonts.gstatic.com') ||
         url.hostname.includes('js.stripe.com');
}

// ─── Estrategia: Network-first con timeout y fallback a cache ────────────────
async function networkFirst(req, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // {cache: 'no-cache'} fuerza al browser a NO usar su HTTP cache.
    // Esto es crítico para evitar que el SW reciba HTML viejo del browser cache.
    const response = await fetch(req, {
      cache: 'no-cache',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (response.ok && req.url.startsWith(self.location.origin)) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {});
    }
    return response;
  } catch (err) {
    clearTimeout(timer);
    const cached = await caches.match(req);
    if (cached) return cached;
    // Fallback final: para navegación, intentar shell desde cache
    if (req.mode === 'navigate') {
      const shell = await caches.match('/') || await caches.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ─── Estrategia: Cache-first ─────────────────────────────────────────────────
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const response = await fetch(req);
    if (response.ok) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {});
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// ─── Fetch handler: routing por tipo de recurso ──────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // API Supabase/Stripe/Google: NO interceptar (siempre van a red)
  if (isAPIRequest(url)) return;

  // Storage Supabase (fotos de campos): cache-first
  if (isStorageRequest(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // CDN versionado (React, Babel, fonts, Stripe): cache-first
  if (isCDNAsset(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // HTML / navegación: network-first con timeout 3s
  if (isHTMLRequest(event.request)) {
    event.respondWith(networkFirst(event.request, HTML_TIMEOUT_MS));
    return;
  }

  // Resto de assets propios (CSS, JS, imágenes): network-first con timeout 5s
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request, ASSET_TIMEOUT_MS));
    return;
  }
});

// ─── Push notifications (sin cambios funcionales vs v16) ─────────────────────
self.addEventListener('push', event => {
  let data = { title: 'Partee Golf', body: 'Tienes una notificación', tag: 'general' };

  try {
    if (event.data) {
      const payload = event.data.json();
      data = {
        title: payload.title || data.title,
        body: payload.body || payload.message || data.body,
        tag: payload.tag || data.tag,
        data: { url: payload.url || 'https://www.partee.com.mx' }
      };
    }
  } catch (e) {
    if (event.data) {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      requireInteraction: false,
      data: data.data || { url: 'https://www.partee.com.mx' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || 'https://www.partee.com.mx';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if (client.url.includes('partee.com.mx') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// ─── Mensaje SKIP_WAITING desde el cliente (compat futura) ───────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
