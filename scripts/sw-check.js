// Dependency-free checks for the app-wide service worker.
// Run: node scripts/sw-check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, '..', 'public');
const swPath = path.join(publicDir, 'sw.js');
const source = fs.readFileSync(swPath, 'utf8');
const listeners = {};
const response = { clone() { return response; } };
const deletedCaches = [];
// The current cache is whatever sw.js names, so a version bump never breaks this check.
const currentCache = (source.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
const activationCacheNames = [
  'all-in-poker-v88',
  currentCache,
  'venue-timer-offline-v1',
  'some-other-cache'
];
let clientsClaimCalls = 0;
const cache = {
  addAll() { return Promise.resolve(); },
  put() { return Promise.resolve(); }
};
const sandbox = {
  URL,
  Response: { error() { return response; } },
  caches: {
    delete(name) { deletedCaches.push(name); return Promise.resolve(true); },
    keys() { return Promise.resolve(activationCacheNames); },
    match() { return Promise.resolve(undefined); },
    open() { return Promise.resolve(cache); }
  },
  clients: { claim() { clientsClaimCalls++; return Promise.resolve(); } },
  console,
  fetch() { return Promise.resolve(response); },
  self: {
    location: { origin: 'https://app.test' },
    addEventListener(name, listener) { listeners[name] = listener; },
    skipWaiting() {}
  }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: swPath });

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const installUrls = Array.from(vm.runInContext('INSTALL_URLS', sandbox));
check('INSTALL_URLS has no duplicate entries', new Set(installUrls).size === installUrls.length, installUrls);
for (const entry of installUrls.filter((url) => url !== '/')) {
  const file = path.join(publicDir, entry.replace(/^\/+/, ''));
  check(`install entry exists as a file: ${entry}`, fs.existsSync(file) && fs.statSync(file).isFile());
}

const fetchListener = listeners.fetch;
function dispatchFetch(name, url, { method = 'GET', mode = 'no-cors', accept = '' } = {}, expected) {
  let respondWithCalled = false;
  fetchListener({
    request: {
      url,
      method,
      mode,
      headers: { get(header) { return header.toLowerCase() === 'accept' ? accept : null; } }
    },
    respondWith() { respondWithCalled = true; }
  });
  check(name, respondWithCalled === expected, { expected, actual: respondWithCalled });
}

dispatchFetch('Firestore Listen stream bypasses the worker',
  'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel?x=1', {}, false);
dispatchFetch('Firebase Storage image bypasses the worker',
  'https://firebasestorage.googleapis.com/v0/b/bucket/o/a.jpg?alt=media', {}, false);
dispatchFetch('Cloud Functions request bypasses the worker',
  'https://us-central1-x.cloudfunctions.net/getSchedule', {}, false);
dispatchFetch('/api rewrite bypasses the worker', 'https://app.test/api/server-time', {}, false);
dispatchFetch('Firebase reserved auth URL bypasses the worker', 'https://app.test/__/auth/handler', {}, false);
dispatchFetch('same-origin navigation uses the worker', 'https://app.test/index.html', { mode: 'navigate' }, true);
dispatchFetch('same-origin image uses the worker', 'https://app.test/img/hero-bg.jpg', {}, true);
dispatchFetch('same-origin versioned script uses the worker', 'https://app.test/firebase-api.js?v=13', {}, true);
dispatchFetch('POST request bypasses the worker', 'https://app.test/index.html', { method: 'POST', mode: 'navigate' }, false);

async function checkActivation() {
  let activationPromise;
  listeners.activate({ waitUntil(promise) { activationPromise = promise; } });
  await activationPromise;

  check('activate deletes old app cache', deletedCaches.includes('all-in-poker-v88'));
  check('activate keeps current app cache', !!currentCache && !deletedCaches.includes(currentCache), currentCache);
  check('activate keeps timer worker cache', !deletedCaches.includes('venue-timer-offline-v1'));
  check('activate keeps unrelated cache', !deletedCaches.includes('some-other-cache'));
  check('activate claims clients', clientsClaimCalls > 0);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

checkActivation().catch((error) => {
  failures++;
  console.log(`FAIL activate lifecycle check -> ${JSON.stringify(error.message)}`);
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
});
