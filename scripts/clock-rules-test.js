// Evaluate the shared-clock rules in firestore.rules (timerClocks and its
// presses log) against synthetic requests via the Firebase Rules API test
// endpoint. Does NOT deploy and does not touch live data.
//   node scripts/clock-rules-test.js
// Same approach as rules-test.js, but every signed-in request carries a full
// token (email, sign_in_provider), which signedIn() reads since 2026-10-08.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const P = 'demo-poker';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const D = '/databases/(default)/documents';
const TIME = '2026-10-16T19:00:00Z';

const profileMock = (uid, data) => ([
  { function: 'exists', args: [{ exact_value: D + '/userProfiles/' + uid }], result: { value: data !== null } },
  { function: 'get', args: [{ exact_value: D + '/userProfiles/' + uid }], result: { value: data === null ? null : { data } } }
]);
const auth = (uid, email, provider = 'google.com') => ({ uid, token: { email, firebase: { sign_in_provider: provider } } });
const STAFF = { auth: auth('staff1', 'dealer@example.com'), mocks: profileMock('staff1', { role: 'staff' }) };
const ADMIN = { auth: auth('admin1', 'boss@example.com'), mocks: profileMock('admin1', { role: 'admin' }) };
const PLAYER = { auth: auth('player1', 'bob@example.com'), mocks: profileMock('player1', { role: 'player' }) };
const ANON = { auth: auth('anon1', '', 'anonymous'), mocks: profileMock('anon1', null) };
const NOBODY = { auth: null, mocks: [] };

const PRESSES = D + '/timerClocks/test-clock-claude-vdtw/presses/p1';
const CLOCK = D + '/timerClocks/test-clock-claude-vdtw';

// A record as clock-sync.js logPress writes it; `at` is the server time.
const press = (who, extra = {}) => Object.assign({
  action: 'toggle', game: '1', levelIndex: 1, remainingMs: 540000, phase: 'running',
  status: 'paused', changedAt: 1792177200000, via: 'button', device: 'phone',
  by: { uid: who.auth.uid, email: who.auth.token.email, name: 'Test Person' },
  at: TIME
}, extra);

const T = (name, expectation, who, method, p, data, existing) => {
  const request = { auth: who.auth, path: p, method, time: TIME };
  if (data) request.resource = { data };
  const c = { _name: name, expectation, request };
  if (existing) c.resource = { data: existing };
  if (who.mocks.length) c.functionMocks = who.mocks;
  return c;
};

const cases = [
  // presses: who may add a record
  T('staff adds a press record', 'ALLOW', STAFF, 'create', PRESSES, press(STAFF)),
  T('admin adds a press record', 'ALLOW', ADMIN, 'create', PRESSES, press(ADMIN)),
  T('TV record (space bar, device tv)', 'ALLOW', STAFF, 'create', PRESSES, press(STAFF, { action: 'pause', device: 'tv', via: 'key' })),
  T('TV back-from-Local record', 'ALLOW', STAFF, 'create', PRESSES, press(STAFF, { action: 'shared', device: 'tv' })),
  T('signed-out adds a press record', 'DENY', NOBODY, 'create', PRESSES, press(STAFF)),
  T('player (non-staff) adds a press record', 'DENY', PLAYER, 'create', PRESSES, press(PLAYER)),
  T('anonymous contest visitor adds a press record', 'DENY', ANON, 'create', PRESSES, press(ANON)),

  // presses: a record must be honest about who and when
  T('staff logs a press as another account (uid)', 'DENY', STAFF, 'create', PRESSES,
    press(STAFF, { by: { uid: 'admin1', email: 'dealer@example.com', name: 'X' } })),
  T('staff logs a press with another email', 'DENY', STAFF, 'create', PRESSES,
    press(STAFF, { by: { uid: 'staff1', email: 'boss@example.com', name: 'X' } })),
  T('staff logs a press with a made-up time', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { at: '2026-10-15T01:00:00Z' })),
  T('staff adds an unknown field', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { note: 'hi' })),
  T('staff adds an unknown action', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { action: 'explode' })),
  T('staff adds a bad game key', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { game: '3' })),
  T('staff adds a bad device', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { device: 'laptop' })),
  T('staff leaves out status', 'DENY', STAFF, 'create', PRESSES, (({ status, ...rest }) => rest)(press(STAFF))),
  T('staff leaves out by.name', 'DENY', STAFF, 'create', PRESSES,
    press(STAFF, { by: { uid: 'staff1', email: 'dealer@example.com' } })),
  T('staff sends levelIndex as text', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { levelIndex: '1' })),
  T('staff sends remainingMs as text', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { remainingMs: '9:00' })),
  T('staff sends a bad phase', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { phase: 'stopped' })),
  T('staff sends a bad status', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { status: 'holding' })),
  T('staff sends a bad via', 'DENY', STAFF, 'create', PRESSES, press(STAFF, { via: 'voice' })),
  T('staff with a 100-character name', 'ALLOW', STAFF, 'create', PRESSES,
    press(STAFF, { by: { uid: 'staff1', email: 'dealer@example.com', name: 'x'.repeat(100) } })),
  T('staff with a 101-character name', 'DENY', STAFF, 'create', PRESSES,
    press(STAFF, { by: { uid: 'staff1', email: 'dealer@example.com', name: 'x'.repeat(101) } })),
  T('staff account with no email in its token', 'ALLOW',
    { auth: { uid: 'staff1', token: { firebase: { sign_in_provider: 'google.com' } } }, mocks: STAFF.mocks }, 'create', PRESSES,
    press(STAFF, { by: { uid: 'staff1', email: '', name: '' } })),

  // presses: reading, editing, removing
  T('staff reads the log', 'ALLOW', STAFF, 'get', PRESSES),
  T('staff lists the log', 'ALLOW', STAFF, 'list', PRESSES),
  T('player reads the log', 'DENY', PLAYER, 'get', PRESSES),
  T('signed-out reads the log', 'DENY', NOBODY, 'list', PRESSES),
  T('staff edits a record', 'DENY', STAFF, 'update', PRESSES, press(STAFF, { action: 'start' }), press(STAFF)),
  T('staff removes a record', 'DENY', STAFF, 'delete', PRESSES, null, press(STAFF)),
  T('admin edits a record', 'ALLOW', ADMIN, 'update', PRESSES, press(STAFF, { action: 'start' }), press(STAFF)),
  T('admin removes a record', 'ALLOW', ADMIN, 'delete', PRESSES, null, press(STAFF)),

  // the clock document rule is unchanged
  T('signed-out reads a clock', 'ALLOW', NOBODY, 'get', CLOCK),
  T('staff writes a clock', 'ALLOW', STAFF, 'update', CLOCK,
    { venue: 'test-clock-claude-vdtw', games: {}, updatedAt: TIME, updatedBy: { device: 'phone' } }, { venue: 'test-clock-claude-vdtw' }),
  T('player writes a clock', 'DENY', PLAYER, 'update', CLOCK,
    { venue: 'test-clock-claude-vdtw', games: {} }, { venue: 'test-clock-claude-vdtw' }),
  T('staff writes a clock with a presses field', 'DENY', STAFF, 'update', CLOCK,
    { venue: 'test-clock-claude-vdtw', presses: [] }, { venue: 'test-clock-claude-vdtw' })
];

const names = cases.map((c) => c._name);
cases.forEach((c) => { delete c._name; });

fetch('https://firebaserules.googleapis.com/v1/projects/' + P + ':test', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'x-goog-user-project': P },
  body: JSON.stringify({
    source: { files: [{ name: 'firestore.rules', content: RULES }] },
    testSuite: { testCases: cases }
  })
}).then((r) => r.json()).then((j) => {
  if (j.error) { console.error('API error:', JSON.stringify(j.error, null, 2)); process.exit(1); }
  if (j.issues && j.issues.length) {
    console.log('=== COMPILE ISSUES ===');
    j.issues.forEach((i) => console.log(' ' + i.severity + ' line ' + (i.sourcePosition && i.sourcePosition.line) + ': ' + i.description));
  }
  const res = j.testResults || [];
  let pass = 0, fail = 0;
  res.forEach((r, i) => {
    const ok = r.state === 'SUCCESS';
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + names[i]);
    if (!ok && r.debugMessages) r.debugMessages.slice(0, 2).forEach((m) => console.log('        ' + m));
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + res.length + ' total');
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
