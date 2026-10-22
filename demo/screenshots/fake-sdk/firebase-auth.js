const authByApp = new WeakMap();
const listeners = new Set();

function selectedIdentity() {
  if (typeof window === "undefined") return null;
  return window.__DEMO_AUTH || null;
}

function makeUser(identity, anonymous = false) {
  if (!identity) return null;
  const email = identity.email || null;
  const providerId = anonymous ? "anonymous" : (identity.providerId || "google.com");
  return {
    uid: identity.uid || (anonymous ? "demo-anonymous" : "demo-admin"),
    email,
    displayName: identity.displayName || email,
    isAnonymous: anonymous,
    providerId,
    emailVerified: Boolean(identity.emailVerified),
    getIdToken: async () => "demo-token",
    getIdTokenResult: async () => ({
      token: "demo-token",
      claims: {
        email,
        firebase: { sign_in_provider: providerId }
      }
    })
  };
}

function notifyAuthState(auth) {
  const user = auth.currentUser;
  for (const entry of [...listeners]) {
    if (entry.auth === auth && entry.active) queueMicrotask(() => entry.callback(user));
  }
}

export function getAuth(app) {
  const key = app || globalThis;
  if (!authByApp.has(key)) {
    const auth = {
      app,
      _anonymousUser: null,
      get currentUser() {
        return this._anonymousUser || makeUser(selectedIdentity());
      },
      authStateReady() {
        return Promise.resolve();
      }
    };
    authByApp.set(key, auth);
  }
  return authByApp.get(key);
}

export class GoogleAuthProvider {
  static GOOGLE_SIGN_IN_METHOD = "google.com";

  constructor() {
    this.providerId = "google.com";
    this.scopes = [];
    this.customParameters = {};
  }

  addScope(scope) {
    this.scopes.push(scope);
  }

  setCustomParameters(parameters) {
    this.customParameters = { ...parameters };
  }
}

export function onAuthStateChanged(auth, callback, errorCallback) {
  const entry = { auth, callback, errorCallback, active: true };
  listeners.add(entry);
  queueMicrotask(() => {
    if (entry.active) callback(auth.currentUser);
  });
  return () => {
    entry.active = false;
    listeners.delete(entry);
  };
}

export async function signInWithPopup(auth) {
  if (!auth.currentUser) {
    if (typeof window !== "undefined") {
      window.__DEMO_AUTH = { uid: "demo-admin", email: "admin@example.com" };
    }
  }
  notifyAuthState(auth);
  return { user: auth.currentUser, providerId: "google.com", operationType: "signIn" };
}

export async function signInWithRedirect(auth) {
  return signInWithPopup(auth);
}

export async function getRedirectResult() {
  return null;
}

export async function signOut(auth) {
  auth._anonymousUser = null;
  if (typeof window !== "undefined") window.__DEMO_AUTH = null;
  notifyAuthState(auth);
}

export async function signInAnonymously(auth) {
  auth._anonymousUser = makeUser({ uid: "demo-anonymous", email: null }, true);
  notifyAuthState(auth);
  return { user: auth._anonymousUser, providerId: "anonymous", operationType: "signIn" };
}
