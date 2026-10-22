// Firestore access for shot orders (shotRounds, shotOptions), signed in.
//
// firestore.rules refuses signed-out writes to those collections (2026-10-19),
// but shots.html and bar.html run signed out on game night. So each device
// signs in to an anonymous account, on a separate named Firebase app:
//   - the anonymous account never becomes the poker app's signed-in user, so
//     other pages (and a player's Google sign-in) are untouched, and the
//     rules' signedIn() keeps treating anonymous accounts as signed out;
//   - the account persists on the device, so it is created once, not per visit.
//
// Pages read and write shot orders through `db` from here (one instance, so
// a page's own writes still show in its listeners at once) and call
// `await ready()` before each write.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const APP_NAME = 'shot-orders';

// defaultApp: the `app` export of firebase-api.js (only its config is used, so
// this module never imports firebase-api.js and never pins a ?v= of its own).
export function shotOrders(defaultApp) {
  const app = getApps().find(a => a.name === APP_NAME) || initializeApp(defaultApp.options, APP_NAME);
  const auth = getAuth(app);
  const db = getFirestore(app);
  let signingIn = null;

  // Resolves once this device has its anonymous account. A failed sign-in
  // (offline) rejects so the caller's write fails visibly; the next call
  // tries again.
  function ready() {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    if (!signingIn) {
      signingIn = auth.authStateReady()
        .then(() => auth.currentUser || signInAnonymously(auth).then(cred => cred.user))
        .finally(() => { signingIn = null; });
    }
    return signingIn;
  }

  ready().catch(() => {});   // start at page load so the first order isn't slowed
  return { db, ready };
}
