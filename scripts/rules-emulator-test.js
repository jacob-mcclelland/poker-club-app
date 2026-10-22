// Run firestore.rules against the Firestore emulator: every case in
// scripts/rules-test.js, plus cases that need server timestamps and
// increments, which the Rules API test format cannot express.
// Offline, no key, no live data. Needs Java 17+ for the emulator.
//
// Run from the app root:
//   firebase emulators:exec --only firestore --project demo-poker-test "node scripts/rules-emulator-test.js"
// Optional argument: a different rules file to load (to show a case fails
// against an older ruleset).
const fs = require('fs');
const path = require('path');
const { cases, D } = require('./rules-test.js');

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set; run this under firebase emulators:exec (see the header).');
  process.exit(1);
}
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-poker-test';
const RULES_FILE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'firestore.rules'));
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const NAME_ROOT = `projects/${PROJECT}/databases/(default)/documents`;

// ── Firestore REST plumbing ──────────────────────────────────────────────────
const b64url = s => Buffer.from(JSON.stringify(s)).toString('base64url');
// The emulator accepts unsigned tokens; 'owner' bypasses rules for seeding.
function tokenFor(auth) {
  if (!auth) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.assign({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    iat: now, exp: now + 3600, auth_time: now, sub: auth.uid, user_id: auth.uid
  }, auth.token || {});
  payload.firebase = Object.assign({ identities: {} }, payload.firebase || {});
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
}

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  return { mapValue: { fields: encodeFields(v) } };
}
function encodeFields(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(k => { out[k] = encode(obj[k]); });
  return out;
}

async function call(method, url, bearer, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text };
}

// writes: [{ path, data, merge, transforms: { field: 'time' | { increment: n } }, exists }] or { path, delete: true }
function commitBody(writes) {
  return {
    writes: writes.map(w => {
      const name = `${NAME_ROOT}/${w.path}`;
      if (w.delete) return { delete: name };
      const write = { update: { name, fields: encodeFields(w.data) } };
      if (w.merge) write.updateMask = { fieldPaths: Object.keys(w.data || {}).map(k => '`' + k + '`') };
      const transforms = Object.entries(w.transforms || {}).map(([fieldPath, t]) =>
        t === 'time' ? { fieldPath, setToServerValue: 'REQUEST_TIME' } : { fieldPath, increment: encode(t.increment) });
      if (transforms.length) write.updateTransforms = transforms;
      if (w.exists !== undefined) write.currentDocument = { exists: w.exists };
      return write;
    })
  };
}
const commit = (bearer, writes) => call('POST', `${BASE}:commit`, bearer, commitBody(writes));
const seed = docs => docs.length ? commit('owner', docs) : Promise.resolve({ status: 200 });
const clearAll = () => call('DELETE', `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`);

async function loadRules() {
  const content = fs.readFileSync(RULES_FILE, 'utf8');
  const res = await call('PUT', `http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`, null,
    { rules: { files: [{ name: 'firestore.rules', content }] } });
  if (res.status !== 200) throw new Error('rules failed to load: ' + res.text);
}

// ALLOW = the rules let the request through (a get of a missing doc is 404
// after the rules passed). DENY = 403 PERMISSION_DENIED. Anything else is an
// error in the test, reported as a failure.
function verdict(res, method) {
  if (res.status === 200 || (method === 'get' && res.status === 404)) return 'ALLOW';
  if (res.status === 403) return 'DENY';
  return 'ERROR ' + res.status + ' ' + res.text.slice(0, 200);
}

// ── Cases shared with rules-test.js (Rules API format) ───────────────────────
function seedFromMocks(mocks) {
  return (mocks || [])
    .filter(m => m.function === 'get' && m.result.value)
    .map(m => ({ path: m.args[0].exact_value.slice(D.length + 1), data: m.result.value.data }));
}

async function runSharedCase(c) {
  const req = c.request;
  const docPath = req.path.slice(D.length + 1);
  const docs = seedFromMocks(c.functionMocks);
  if (c.resource) docs.push({ path: docPath, data: c.resource.data });
  await seed(docs);
  const bearer = tokenFor(req.auth);
  let res;
  if (req.method === 'get') res = await call('GET', `${BASE}/${docPath}`, bearer);
  else if (req.method === 'list') res = await call('GET', `${BASE}/${docPath.split('/').slice(0, -1).join('/')}`, bearer);
  else if (req.method === 'delete') res = await commit(bearer, [{ path: docPath, delete: true }]);
  else res = await commit(bearer, [{ path: docPath, data: req.resource.data, exists: req.method === 'update' }]);
  return verdict(res, req.method);
}

// ── Emulator-only cases (server timestamps, increments, real page payloads) ──
const anon = uid => ({ uid, token: { firebase: { sign_in_provider: 'anonymous' } } });
const google = uid => ({ uid, token: { email: uid + '@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } } });
const ADMIN_PROFILE = { path: 'userProfiles/admin1', data: { role: 'admin', linkedName: 'Boss' } };

// buildCardPayload('draft') from shots.html, minus the serverTimestamp fields
const draft = () => ({
  venue: 'Tight End', eventType: 'Regular', gameNum: 1, gameLabel: 'Game 1 · 7PM',
  sessionDate: '10/19/2026', table: 'hearts', submitter: { name: 'Sam' },
  players: [{ name: 'Sam', payment: 'card', shots: [{ type: 'House', qty: 2, note: 'salt' }] }],
  clientId: 'c_test1', status: 'draft'
});
const CARD = 'shotRounds/card1';

const emulatorCases = [
  { name: 'shots.html: anonymous account saves a draft card (serverTimestamp fields)', expect: 'ALLOW',
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, data: draft(), transforms: { timestamp: 'time', updatedAt: 'time' } }]) },
  { name: 'shots.html: signed-out caller saves the same draft card', expect: 'DENY',
    run: () => commit(null, [{ path: CARD, data: draft(), transforms: { timestamp: 'time', updatedAt: 'time' } }]) },
  { name: 'shots.html: anonymous account submits its draft (merge, status pending)', expect: 'ALLOW',
    seed: [{ path: CARD, data: Object.assign(draft(), { timestamp: new Date(), updatedAt: new Date() }) }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, merge: true,
      data: (({ clientId, ...rest }) => Object.assign(rest, { status: 'pending' }))(draft()),
      transforms: { submittedAt: 'time', timestamp: 'time', updatedAt: 'time' } }]) },
  { name: 'anonymous account back-dates a card timestamp', expect: 'DENY',
    seed: [{ path: CARD, data: Object.assign(draft(), { timestamp: new Date(), updatedAt: new Date() }) }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, merge: true, data: { timestamp: new Date('2026-01-01T00:00:00Z') } }]) },
  { name: 'anonymous account writes 41 players on one card', expect: 'DENY',
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD,
      data: Object.assign(draft(), { players: Array.from({ length: 41 }, (_, i) => ({ name: 'P' + i, payment: 'card', shots: [] })) }) }]) },
  { name: 'shots.html: anonymous account flips a player to cash (players + updatedAt)', expect: 'ALLOW',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'pending', poured: true, timestamp: new Date() }) }],
    run: () => commit(tokenFor(anon('anonB')), [{ path: CARD, merge: true,
      data: { players: [{ name: 'Sam', payment: 'cash', shots: [{ type: 'House', qty: 2 }] }] }, transforms: { updatedAt: 'time' } }]) },
  { name: 'bar.html: anonymous tablet marks a card poured and paid', expect: 'ALLOW',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'pending', timestamp: new Date() }) }],
    run: () => commit(tokenFor(anon('tablet')), [{ path: CARD, merge: true,
      data: { poured: true, paid: true, status: 'closed' }, transforms: { pouredAt: 'time', paidAt: 'time' } }]) },
  { name: 'bar.html: signed-out tablet marks a card poured', expect: 'DENY',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'pending', timestamp: new Date() }) }],
    run: () => commit(null, [{ path: CARD, merge: true, data: { poured: true, status: 'pending' }, transforms: { pouredAt: 'time' } }]) },
  { name: 'anonymous account un-pours a poured card (first step of a delete)', expect: 'DENY',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'pending', poured: true }) }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, merge: true, data: { poured: false, status: 'pending' } }]) },
  { name: 'anonymous account reopens a closed card', expect: 'DENY',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'closed', poured: true, paid: true }) }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, merge: true, data: { status: 'pending' } }]) },
  { name: 'anonymous account un-pays a paid card', expect: 'DENY',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'pending', paid: true }) }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, merge: true, data: { paid: false } }]) },
  { name: 'bar.html: marking a legacy filled card paid closes it', expect: 'ALLOW',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'filled' }) }],
    run: () => commit(tokenFor(anon('tablet')), [{ path: CARD, merge: true,
      data: { paid: true, status: 'closed' }, transforms: { paidAt: 'time' } }]) },
  { name: 'anonymous account sets a legacy filled card back to pending', expect: 'DENY',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'filled' }) }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, merge: true, data: { status: 'pending' } }]) },
  { name: 'bar.html: pouring a paid card closes it', expect: 'ALLOW',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'pending', paid: true }) }],
    run: () => commit(tokenFor(anon('tablet')), [{ path: CARD, merge: true,
      data: { poured: true, status: 'closed' }, transforms: { pouredAt: 'time' } }]) },
  { name: 'anonymous account deletes a card the bar is pouring', expect: 'DENY',
    seed: [{ path: CARD, data: Object.assign(draft(), { status: 'pending', poured: true }) }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: CARD, delete: true }]) },
  { name: 'admin deletes a closed card', expect: 'ALLOW',
    seed: [ADMIN_PROFILE, { path: CARD, data: Object.assign(draft(), { status: 'closed', poured: true, paid: true }) }],
    run: () => commit(tokenFor(google('admin1')), [{ path: CARD, delete: true }]) },
  { name: 'shots.html: anonymous account seeds an option (name + increment(0))', expect: 'ALLOW',
    run: () => commit(tokenFor(anon('anonA')), [{ path: 'shotOptions/house', merge: true, data: { name: 'House' }, transforms: { count: { increment: 0 } } }]) },
  { name: 'shots.html: anonymous account counts an order (increment(1))', expect: 'ALLOW',
    seed: [{ path: 'shotOptions/house', data: { name: 'House', count: 12 } }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: 'shotOptions/house', merge: true, data: { name: 'House' }, transforms: { count: { increment: 1 } } }]) },
  { name: 'anonymous account inflates an option (increment(5))', expect: 'DENY',
    seed: [{ path: 'shotOptions/house', data: { name: 'House', count: 12 } }],
    run: () => commit(tokenFor(anon('anonA')), [{ path: 'shotOptions/house', merge: true, data: {}, transforms: { count: { increment: 5 } } }]) },
  { name: 'signed-out caller counts an order', expect: 'DENY',
    seed: [{ path: 'shotOptions/house', data: { name: 'House', count: 12 } }],
    run: () => commit(null, [{ path: 'shotOptions/house', merge: true, data: {}, transforms: { count: { increment: 1 } } }]) },
  { name: 'anonymous contest visitor still cannot write a checkin', expect: 'DENY',
    run: () => commit(tokenFor(anon('anonA')), [{ path: 'checkins/x', data: { player: 'Fake' } }]) },
  { name: 'admin still cannot write a checkin directly (adminEditGameRecord does)', expect: 'DENY',
    seed: [ADMIN_PROFILE],
    run: () => commit(tokenFor(google('admin1')), [{ path: 'checkins/x', data: { player: 'Sam', venue: 'Tight End', date: '10/19/2026', gameNum: 1, addedByAdmin: true } }]) }
];

(async () => {
  await loadRules();
  console.log('rules: ' + RULES_FILE);
  let pass = 0, fail = 0;
  const report = (name, expected, got) => {
    const ok = got === expected;
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  (expected ${expected}, got ${got})`));
  };
  for (const c of cases) {
    await clearAll();
    report(c._name, c.expectation, await runSharedCase(c));
  }
  for (const c of emulatorCases) {
    await clearAll();
    await seed(c.seed || []);
    report(c.name, c.expect, verdict(await c.run(), 'write'));
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
