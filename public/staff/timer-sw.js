// Venue timer offline worker (docs/timer-prd/07-synced-clock.md, Part 3b).
//
// Registered by staff/timer.html with scope /staff/timer, so it controls only
// the timer pages (timer, timer-classic, the themed variants) and never the
// player app. It is separate from /sw.js on purpose: that worker's install
// has failed in Chrome since about May 2026 ('/announcements.html' appears
// twice in its cache.addAll list, which Chrome rejects), and the TV's offline
// copy must not depend on it.
//
// Nothing is precached at install, so install cannot fail. The timer page
// posts every URL it loaded (WARM_CACHE) and those are kept in TIMER_CACHE.

const TIMER_CACHE = 'venue-timer-offline-v1';
const FIREBASE_SDK_PREFIX = 'https://www.gstatic.com/firebasejs/';
// Venue Wi-Fi with no internet makes requests hang rather than fail, so the
// timer's own files give up on the network after a few seconds.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith('venue-timer-offline-') && name !== TIMER_CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

function isWarmableUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.origin === self.location.origin) return !url.pathname.startsWith('/api/');
    return raw.startsWith(FIREBASE_SDK_PREFIX);
  } catch (e) {
    return false;
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'WARM_CACHE' || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter(isWarmableUrl).slice(0, 200);
  // Versioned files (?v=, the pinned SDK) never change: skip ones already held.
  const isVersioned = (url) => url.startsWith(FIREBASE_SDK_PREFIX) || /[?&]v=/.test(url);
  event.waitUntil(
    caches.open(TIMER_CACHE).then((cache) =>
      Promise.all(urls.map(async (url) => {
        if (isVersioned(url) && await cache.match(url)) return;
        await cache.add(url).catch(() => {});
      }))
    )
  );
});

function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), NETWORK_TIMEOUT_MS);
    fetch(request).then(
      (response) => { clearTimeout(timer); resolve(response); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // The pinned Firebase SDK never changes: cache first.
  if (request.url.startsWith(FIREBASE_SDK_PREFIX)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(TIMER_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  // Everything else cross-origin (Firestore's live channel, Cloud Functions,
  // Google sign-in) and live endpoints (server time) go straight to the
  // network, untouched. Firestore's channel stays open on purpose; a timeout
  // would cut it.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Same-origin files: network first (so a deploy shows up), cache when the
  // network fails or hangs.
  event.respondWith(
    fetchWithTimeout(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(TIMER_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      // Same page, different query (timer.html?venue=corgi vs the cached URL).
      if (request.mode === 'navigate') {
        const samePage = await caches.match(request, { ignoreSearch: true });
        if (samePage) return samePage;
      }
      return Response.error();
    })
  );
});
