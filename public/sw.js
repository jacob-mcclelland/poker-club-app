// Service worker tuned for fast assets but fresh app shells.
//
// PUSH MESSAGING — DISABLED (2026-04-22)
// firebase-messaging-compat.js and firebase.messaging() were removed here.
// Calling firebase.messaging() at SW top level (outside an event handler)
// caused the SW to fail to install in some browsers, taking the whole app down.
// See the comments in firebase-api.js (near "enablePushNotifications") for the
// full reinstatement checklist before adding messaging back.
// IMPORTANT: bump this version with EVERY hosting deploy that changes any
// page or JS. The byte-change is what makes browsers install the new SW,
// which (via skipWaiting + controllerchange in update-check.js) auto-reloads
// open pages — including kiosk tablets that stay open all night — within
// ~5 minutes. An unbumped deploy leaves offline fallbacks serving the old
// app shell against the new Cloud Functions API.
const CACHE_NAME = 'all-in-poker-v105';

const APP_SHELL_FALLBACKS = [
  '/',
  '/index.html',
  '/home.html',
  '/announcements.html',
  '/stats.html',
  '/leaderboard.html',
  '/rsvp.html',
  '/gameday.html',
  '/shots.html',
  '/bar.html',
  '/bar-qr.html'
];

const STATIC_ASSETS = [
  '/manifest.json',
  '/manifest-gameday.json',
  '/img/hero-bg.jpg',
  '/img/favicon-32.png',
  '/img/favicon-16.png',
  '/img/apple-touch-icon.png',
  '/img/app-icon-192.png',
  '/img/app-icon-512.png',
  '/img/gameday-icon-premium.png'
];

// cache.addAll rejects a list that names the same URL twice, and a rejected
// install leaves no worker at all. A duplicate '/announcements.html' did that
// from about May to October 2026, so the list is deduped here.
const INSTALL_URLS = [...new Set([...APP_SHELL_FALLBACKS, ...STATIC_ASSETS])];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(INSTALL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Cache Storage is shared with the timer worker (staff/timer-sw.js), so remove only this worker's old caches.
          if (cacheName.startsWith('all-in-poker-') && cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);
  // Same-origin pages, scripts, and images only (the owner, 2026-10-14).
  // Firestore has its own offline handling; caching stream traffic bloats storage.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/__/')) return;

  const isNavigation = event.request.mode === 'navigate';
  const isHtmlDocument =
    event.request.headers.get('accept')?.includes('text/html') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/';

  if (isNavigation || isHtmlDocument) {
    event.respondWith(
      fetch(event.request).then((response) => {
        const cacheCopy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cacheCopy));
        return response;
      }).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;

        for (const fallback of APP_SHELL_FALLBACKS) {
          const fallbackMatch = await caches.match(fallback);
          if (fallbackMatch) return fallbackMatch;
        }

        return Response.error();
      })
    );
    return;
  }

  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const networkFetch = fetch(event.request).then((response) => {
          const cacheCopy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cacheCopy));
          return response;
        });

        return cachedResponse || networkFetch;
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request).then((response) => {
      const cacheCopy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cacheCopy));
      return response;
    }).catch(() => caches.match(event.request))
  );
});
