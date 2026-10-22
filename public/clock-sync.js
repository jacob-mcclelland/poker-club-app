// Synced clock: server-time offset and the Firestore mirror of the clock.
// Design: docs/timer-prd/07-synced-clock.md (Part 4).
//
// No imports on purpose. The page passes in its own firebase-api.js module
// (`fb`), because pages import it under different ?v= URLs and two copies of
// that module would initialize Firebase twice. It also means a page can load
// this file, and run its clock, with no network at all.

const OFFSET_KEY = 'clockServerOffset';
const OFFSET_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Server time
// ---------------------------------------------------------------------------

let calibrated = false;   // true once an offset was measured, now or recently
let offsetMs = readSavedOffset();

function readSavedOffset() {
  try {
    const saved = JSON.parse(localStorage.getItem(OFFSET_KEY) || 'null');
    if (saved && Number.isFinite(saved.offsetMs) && Date.now() - saved.measuredAt < OFFSET_MAX_AGE_MS) {
      calibrated = true;
      return saved.offsetMs;
    }
  } catch (e) { /* storage blocked or corrupt: fall through */ }
  return 0;
}

// False until this device has ever measured its offset. Presses made before
// that are anchored on the raw device clock; the page re-anchors them once
// the first measurement lands (timer.html calibrateClock).
export function isOffsetCalibrated() {
  return calibrated;
}

// Server-time milliseconds: the device clock corrected by the last good
// measurement. Works offline (uses the saved offset, else the device clock).
export function serverNow() {
  return Date.now() + offsetMs;
}

export function currentOffsetMs() {
  return offsetMs;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Sample /api/server-time a few times and keep the fastest round trip; the
// first call may be a cold start, which the fastest sample discards. Falls
// back to the hosting Date header (1 s resolution). Returns the offset, or
// null when the server can't be reached (the old offset stays in use).
export async function measureServerOffset({ samples = 4, timeoutMs = 3000 } = {}) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    try {
      const sentAt = Date.now();
      const res = await fetchWithTimeout('/api/server-time', { cache: 'no-store' }, timeoutMs);
      const receivedAt = Date.now();
      if (!res.ok) continue;
      const body = await res.json();
      if (!Number.isFinite(body.now)) continue;
      const rtt = receivedAt - sentAt;
      if (!best || rtt < best.rtt) best = { rtt, offset: body.now + rtt / 2 - receivedAt };
    } catch (e) {
      break; // offline or timed out: more samples won't help
    }
  }

  if (!best) {
    try {
      const sentAt = Date.now();
      const res = await fetchWithTimeout('/clock-engine.js', { method: 'HEAD', cache: 'no-store' }, timeoutMs);
      const receivedAt = Date.now();
      const date = Date.parse(res.headers.get('date') || '');
      if (Number.isFinite(date)) {
        const rtt = receivedAt - sentAt;
        best = { rtt, offset: date + 500 + rtt / 2 - receivedAt };
      }
    } catch (e) { /* offline */ }
  }

  if (!best) return null;
  offsetMs = Math.round(best.offset);
  calibrated = true;
  try {
    localStorage.setItem(OFFSET_KEY, JSON.stringify({ offsetMs, measuredAt: Date.now(), rtt: best.rtt }));
  } catch (e) { /* storage blocked */ }
  return offsetMs;
}

// ---------------------------------------------------------------------------
// Firestore mirror: timerClocks/{venue}
// ---------------------------------------------------------------------------

// fb       the page's firebase-api.js module (db, doc, onSnapshot, setDoc, serverTimestamp)
// venue    'tight' | 'corgi'
// device   'tv' | 'phone'
// onData   (data | null) => void, the whole document on every change
// onStatus ('live' | 'sending' | 'connecting' | 'denied' | 'error') => void
//          'denied': a write was refused because this device isn't signed in
//          as staff (firestore.rules timerClocks). Reading still works.
export function createClockSync({ fb, venue, device, onData, onStatus }) {
  const ref = fb.doc(fb.db, 'timerClocks', venue);
  let unsub = null;
  let pendingWrites = 0;
  let lastStatus = null;

  function setStatus(status) {
    if (status !== lastStatus) {
      lastStatus = status;
      if (onStatus) onStatus(status);
    }
  }

  function start() {
    if (unsub) return;
    setStatus('connecting');
    unsub = fb.onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
      const meta = snap.metadata;
      // A refused write sticks until the device signs in and writes again.
      if (lastStatus === 'denied' && !meta.hasPendingWrites) {
        onData(snap.exists() ? snap.data() : null, meta);
        return;
      }
      if (pendingWrites > 0 || meta.hasPendingWrites) setStatus('sending');
      else if (meta.fromCache) setStatus('connecting');
      else setStatus('live');
      onData(snap.exists() ? snap.data() : null, meta);
    }, (err) => {
      console.error('[clock-sync] listener failed:', err);
      setStatus('error');
    });
  }

  function stop() {
    if (unsub) {
      unsub();
      unsub = null;
    }
    lastStatus = null;
  }

  // Press log: timerClocks/{id}/presses gets one small record per clock
  // change, so a surprise pause can be traced to a device and an account
  // (2026-10-16). `press` is { action, game, levelIndex, remainingMs, phase,
  // status, changedAt, via } from the page; this adds who, which device and
  // the server time. Written apart from the clock and only after the clock
  // write went through: a refused or failed log never holds up or undoes the
  // clock, and never changes the status the page shows.
  function logPress(press) {
    // Runs inside writeGames' success handler, so nothing here may throw:
    // addDoc throws synchronously on bad data (an undefined field), and that
    // would turn a saved press into a reported failure.
    try {
      const user = fb.auth && fb.auth.currentUser;
      if (!user) return;
      const record = {
        ...press,
        device,
        by: { uid: user.uid, email: user.email || '', name: (user.displayName || '').slice(0, 100) },
        at: fb.serverTimestamp()
      };
      fb.addDoc(fb.collection(ref, 'presses'), record)
        .catch((err) => console.warn('[clock-sync] press log not saved:', err));
    } catch (err) {
      console.warn('[clock-sync] press log not saved:', err);
    }
  }

  // Write whole game objects ({ '1': game, '2': game }, either or both).
  // Resolves to 'ok', 'denied' (rules refused: not signed in as staff) or
  // 'error'. Never awaited by the UI: offline, Firestore queues the write
  // and resolves when it finally reaches the server. `presses` (optional)
  // are press-log records, saved once the write is accepted (logPress).
  function writeGames(games, structure, presses) {
    // setDoc with merge keeps any field the new object leaves out, so an
    // optional flag must always be written explicitly or the old value
    // outlives the press that should have cleared it (found 2026-10-15:
    // noHold from a Prev stayed on after Next).
    const written = {};
    for (const [key, game] of Object.entries(games)) {
      written[key] = { ...game, noHold: game.noHold === true };
    }
    const payload = {
      venue,
      games: written,
      updatedAt: fb.serverTimestamp(),
      updatedBy: { device }
    };
    if (structure) payload.structure = structure;
    pendingWrites++;
    setStatus('sending');
    return fb.setDoc(ref, payload, { merge: true })
      .then(() => {
        pendingWrites--;
        if (pendingWrites === 0 && unsub) setStatus('live');
        if (presses) presses.forEach(logPress);
        return 'ok';
      })
      .catch((err) => {
        pendingWrites--;
        console.error('[clock-sync] write failed:', err);
        const outcome = err && err.code === 'permission-denied' ? 'denied' : 'error';
        setStatus(outcome);
        return outcome;
      });
  }

  return { start, stop, writeGames, get running() { return !!unsub; } };
}
