export function getFunctions(app, region) {
  return { app, region: region || "us-central1" };
}

export function connectFunctionsEmulator() {
  // The browser stand-in always calls the local demo server.
}

function callableAuth() {
  const identity = typeof window === "undefined" ? null : (window.__DEMO_AUTH || null);
  if (!identity) return null;
  return {
    uid: identity.uid,
    token: {
      email: identity.email || null,
      firebase: { sign_in_provider: identity.providerId || "google.com" }
    }
  };
}

function makeCallableError(payload, status) {
  const details = payload?.error || payload;
  const error = new Error(details?.message || details?.details?.message || `Demo function failed (${status})`);
  error.code = details?.code || details?.status || `functions/http-${status}`;
  if (details?.details !== undefined) error.details = details.details;
  return error;
}

async function readError(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { message: response.statusText || `HTTP ${response.status}` };
  }
  return makeCallableError(payload, response.status);
}

export function httpsCallable(_functions, name) {
  return async (data = {}) => {
    const response = await fetch(`/__demo/call/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data, auth: callableAuth() })
    });

    if (!response.ok) throw await readError(response);
    const result = await response.json();
    if (result?.error) throw makeCallableError(result, response.status);
    if (result && Object.prototype.hasOwnProperty.call(result, "data")) return result;
    if (result && Object.prototype.hasOwnProperty.call(result, "result")) return { data: result.result };
    return { data: result };
  };
}
