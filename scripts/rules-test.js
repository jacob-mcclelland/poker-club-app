// Evaluate firestore.rules against synthetic requests via the Firebase Rules
// API test endpoint. Does NOT deploy and does not touch live data.
// The same cases run offline against the Firestore emulator through
// scripts/rules-emulator-test.js, which requires this file for `cases`.
const fs = require('fs');
const { execSync } = require('child_process');
const P = 'demo-poker';
const RULES_PATH = require('path').join(__dirname, '..', 'firestore.rules');
const D = '/databases/(default)/documents';

// Mock the userProfiles lookups the rules helpers perform.
const profileMock = (uid, data) => ([
  { function: 'exists', args: [{ exact_value: D + '/userProfiles/' + uid }], result: { value: data !== null } },
  { function: 'get', args: [{ exact_value: D + '/userProfiles/' + uid }], result: { value: data === null ? null : { data: data } } }
]);
const ADMIN = profileMock('admin1', { role: 'admin', linkedName: 'Boss' });
const STAFF = profileMock('staff1', { role: 'staff', linkedName: 'Dealer' });
const PLAYER = profileMock('player1', { role: 'player', linkedName: 'Bob' });

const auth = (uid, email = uid + '@example.com', provider = 'google.com') => ({ uid, token: { email, firebase: { sign_in_provider: provider } } });

const T = (name, expectation, request, resource, mocks) => {
  const req = Object.assign({}, request);
  if (req.auth && req.auth.uid && !req.auth.token) req.auth = auth(req.auth.uid);
  const c = { _name: name, expectation: expectation, request: Object.assign({ auth: null }, req, { time: '2026-09-05T19:00:00Z' }) };
  if (resource) c.resource = resource;
  if (mocks) c.functionMocks = mocks;
  return c;
};

const cases = [
  // the two holes this ruleset exists to close
  T('anon writes a checkin (standings tampering)', 'DENY',
    { auth: null, path: D + '/checkins/x', method: 'create', resource: { data: { player: 'Fake' } } }),
  T('anonymous token writes a checkin', 'DENY',
    { auth: auth('anon1', 'anon1@example.com', 'anonymous'), path: D + '/checkins/x', method: 'create', resource: { data: { player: 'Fake' } } },
    null, profileMock('anon1', null)),
  // same request as 'player with only linkedName updates own prefs' (ALLOW); only the provider differs
  T('anonymous token updates own prefs', 'DENY',
    { auth: auth('anon2', 'anon2@example.com', 'anonymous'), path: D + '/userProfiles/anon2', method: 'update', resource: { data: { linkedName: 'Nobody', preferences: { newsletter: true } } } },
    { data: { linkedName: 'Nobody' } }, profileMock('anon2', { linkedName: 'Nobody' })),
  T('player sets own role=admin (escalation)', 'DENY',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player1', method: 'update', resource: { data: { linkedName: 'Bob', role: 'admin' } } },
    { data: { linkedName: 'Bob' } }, PLAYER),
  T('player sets own isAdmin=true (escalation)', 'DENY',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player1', method: 'update', resource: { data: { linkedName: 'Bob', isAdmin: true } } },
    { data: { linkedName: 'Bob' } }, PLAYER),

  // signed-out reads the app depends on
  T('anon reads checkins (kiosk, season_health)', 'ALLOW', { auth: null, path: D + '/checkins/x', method: 'get' }),
  T('anon reads bounties (season_health)', 'ALLOW', { auth: null, path: D + '/bounties/x', method: 'get' }),
  T('anon reads schedule (season_health)', 'ALLOW', { auth: null, path: D + '/schedule/x', method: 'get' }),
  T('anon reads seasons (season_health)', 'ALLOW', { auth: null, path: D + '/seasons/x', method: 'get' }),
  T('anon reads players (autocomplete)', 'ALLOW', { auth: null, path: D + '/players/x', method: 'get' }),
  T('anon reads eliminations (leaderboard)', 'ALLOW', { auth: null, path: D + '/eliminations/x', method: 'get' }),
  T('anon reads rsvps (timer seating)', 'ALLOW', { auth: null, path: D + '/rsvps/x', method: 'get' }),
  T('anon reads config (high hands)', 'ALLOW', { auth: null, path: D + '/config/highHands', method: 'get' }),
  T('anon reads announcements', 'ALLOW', { auth: null, path: D + '/announcements/x', method: 'get' }),
  T('anon reads eventContent', 'ALLOW', { auth: null, path: D + '/eventContent/x', method: 'get' }),

  // shot rounds: an account is required (shots.html and bar.html sign in
  // anonymously through shot-orders.js), signed-out writes are refused
  T('anon reads shotRounds (tonight.html, bar.html)', 'ALLOW', { auth: null, path: D + '/shotRounds/x', method: 'get' }),
  T('signed-out caller creates shotRound', 'DENY',
    { auth: null, path: D + '/shotRounds/x', method: 'create', resource: { data: { venue: 'Tight End', status: 'draft' } } }),
  T('anonymous account creates shotRound (shots.html)', 'ALLOW',
    { auth: auth('anon3', 'anon3@example.com', 'anonymous'), path: D + '/shotRounds/x', method: 'create',
      resource: { data: { venue: 'Tight End', status: 'draft', gameNum: 1, table: 'hearts', submitter: { name: 'Sam' }, players: [{ name: 'Sam', payment: 'card', shots: [{ type: 'House', qty: 1 }] }], clientId: 'c_test' } } }),
  T('anonymous account adds an unknown field to a shotRound', 'DENY',
    { auth: auth('anon3', 'anon3@example.com', 'anonymous'), path: D + '/shotRounds/x', method: 'create', resource: { data: { venue: 'Tight End', price: 0 } } }),
  T('anonymous account sets an unknown status', 'DENY',
    { auth: auth('anon3', 'anon3@example.com', 'anonymous'), path: D + '/shotRounds/x', method: 'create', resource: { data: { venue: 'Tight End', status: 'free' } } }),
  T('signed-out caller updates shotRound (old bar tablet pour)', 'DENY',
    { auth: null, path: D + '/shotRounds/x', method: 'update', resource: { data: { status: 'closed', poured: true } } },
    { data: { status: 'pending' } }),
  T('anonymous account marks shotRound poured (bar.html)', 'ALLOW',
    { auth: auth('anon4', 'anon4@example.com', 'anonymous'), path: D + '/shotRounds/x', method: 'update', resource: { data: { status: 'pending', poured: true } } },
    { data: { status: 'pending' } }),
  T('anonymous account updates a legacy filled shotRound payment', 'ALLOW',
    { auth: auth('anon4', 'anon4@example.com', 'anonymous'), path: D + '/shotRounds/x', method: 'update', resource: { data: { status: 'filled', total: { House: 1 }, players: [] } } },
    { data: { status: 'filled', total: { House: 1 }, players: [{ name: 'Sam' }] } }),
  T('signed-out caller deletes a draft shotRound', 'DENY',
    { auth: null, path: D + '/shotRounds/x', method: 'delete' }, { data: { status: 'draft' } }),
  T('anonymous account deletes a draft shotRound', 'ALLOW',
    { auth: auth('anon5', 'anon5@example.com', 'anonymous'), path: D + '/shotRounds/x', method: 'delete' }, { data: { status: 'draft' } }),
  T('anonymous account deletes a poured shotRound', 'DENY',
    { auth: auth('anon5', 'anon5@example.com', 'anonymous'), path: D + '/shotRounds/x', method: 'delete' }, { data: { status: 'pending', poured: true } }),
  T('admin deletes a poured shotRound', 'ALLOW',
    { auth: { uid: 'admin1' }, path: D + '/shotRounds/x', method: 'delete' }, { data: { status: 'closed', poured: true } }, ADMIN),
  T('signed-out caller upserts shotOption', 'DENY',
    { auth: null, path: D + '/shotOptions/fireball', method: 'create', resource: { data: { name: 'Fireball', count: 1 } } }),
  T('anonymous account creates shotOption (write-in)', 'ALLOW',
    { auth: auth('anon6', 'anon6@example.com', 'anonymous'), path: D + '/shotOptions/fireball', method: 'create', resource: { data: { name: 'Fireball', count: 1 } } }),
  T('anonymous account bumps shotOption count by 1', 'ALLOW',
    { auth: auth('anon6', 'anon6@example.com', 'anonymous'), path: D + '/shotOptions/fireball', method: 'update', resource: { data: { name: 'Fireball', count: 8 } } },
    { data: { name: 'Fireball', count: 7 } }),
  T('anonymous account sets shotOption count to 500', 'DENY',
    { auth: auth('anon6', 'anon6@example.com', 'anonymous'), path: D + '/shotOptions/fireball', method: 'update', resource: { data: { name: 'Fireball', count: 500 } } },
    { data: { name: 'Fireball', count: 7 } }),
  T('anonymous account deletes shotOption', 'DENY',
    { auth: auth('anon6', 'anon6@example.com', 'anonymous'), path: D + '/shotOptions/fireball', method: 'delete' }, { data: { name: 'Fireball', count: 7 } }),

  // own-profile writes the player app performs
  T('player creates own profile (claim name)', 'ALLOW',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player1', method: 'create',
      resource: { data: { uid: 'player1', email: 'b@x.example', linkedName: 'Bob', preferredEmail: 'b@x.example', preferences: { newsletter: true } } } },
    null, profileMock('player1', null)),
  T('player updates own preferences', 'ALLOW',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player1', method: 'update', resource: { data: { linkedName: 'Bob', preferences: { newsletter: false } } } },
    { data: { linkedName: 'Bob', preferences: { newsletter: true } } }, PLAYER),
  T('player updates own preferredEmail', 'ALLOW',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player1', method: 'update', resource: { data: { linkedName: 'Bob', preferredEmail: 'new@x.example' } } },
    { data: { linkedName: 'Bob', preferredEmail: 'old@x.example' } }, PLAYER),
  T('staff sets own linkedName (gameday)', 'ALLOW',
    { auth: { uid: 'staff1' }, path: D + '/userProfiles/staff1', method: 'update', resource: { data: { linkedName: 'Dealer Dan' } } },
    { data: { linkedName: 'Dealer' } }, STAFF),
  T('player edits SOMEONE ELSE profile', 'DENY',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player2', method: 'update', resource: { data: { linkedName: 'Hacked' } } },
    { data: { linkedName: 'Victim' } }, PLAYER),
  T('anon reads userProfiles', 'DENY', { auth: null, path: D + '/userProfiles/player1', method: 'get' }),
  T('signed-in reads OWN profile (auth gates)', 'ALLOW',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player1', method: 'get' }, null, PLAYER),
  T('player reads ANOTHER user profile (email leak)', 'DENY',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player2', method: 'get' }, null, PLAYER),
  T('player LISTS all profiles (email dump)', 'DENY',
    { auth: { uid: 'player1' }, path: D + '/userProfiles/player2', method: 'list' }, null, PLAYER),
  T('admin LISTS all profiles (players.html)', 'ALLOW',
    { auth: { uid: 'admin1' }, path: D + '/userProfiles/player2', method: 'list' }, null, ADMIN),
  T('admin reads another user profile', 'ALLOW',
    { auth: { uid: 'admin1' }, path: D + '/userProfiles/player2', method: 'get' }, null, ADMIN),

  // admin paths that must keep working
  T('admin sets another user role (players.html)', 'ALLOW',
    { auth: { uid: 'admin1' }, path: D + '/userProfiles/player2', method: 'update', resource: { data: { role: 'staff', isAdmin: false, isStaff: true } } },
    { data: { role: 'player' } }, ADMIN),
  T('admin writes config/champions (seasons.html)', 'ALLOW',
    { auth: { uid: 'admin1' }, path: D + '/config/champions', method: 'update', resource: { data: { te: 'Winner' } } },
    { data: { te: 'Old' } }, ADMIN),
  // game-inspector writes through adminEditGameRecord now; no browser writes game rows
  T('admin edits a checkin directly', 'DENY',
    { auth: { uid: 'admin1' }, path: D + '/checkins/x', method: 'update', resource: { data: { player: 'Bob' } } },
    { data: { player: 'Bob' } }, ADMIN),
  T('admin creates an elimination directly', 'DENY',
    { auth: { uid: 'admin1' }, path: D + '/eliminations/x', method: 'create', resource: { data: { player: 'Bob', rank: 1 } } }, null, ADMIN),
  T('admin deletes a bounty directly', 'DENY',
    { auth: { uid: 'admin1' }, path: D + '/bounties/x', method: 'delete' }, { data: { player: 'Bob', count: 1 } }, ADMIN),
  T('admin enqueues mail (comms.html)', 'ALLOW',
    { auth: { uid: 'admin1' }, path: D + '/mail/x', method: 'create', resource: { data: { to: 'a@b.example' } } }, null, ADMIN),
  T('staff edits a checkin directly', 'DENY',
    { auth: { uid: 'staff1' }, path: D + '/checkins/x', method: 'update', resource: { data: { player: 'Bob' } } },
    { data: { player: 'Bob' } }, STAFF),
  T('signed-in non-admin writes config', 'DENY',
    { auth: { uid: 'player1' }, path: D + '/config/highHands', method: 'update', resource: { data: { hand: 'x' } } },
    { data: { hand: 'y' } }, PLAYER),
  T('signed-in user with NO profile doc writes checkin', 'DENY',
    { auth: { uid: 'ghost' }, path: D + '/checkins/x', method: 'create', resource: { data: { player: 'X' } } },
    null, profileMock('ghost', null)),

  // server-only collections
  T('anon reads emailList (subscriber emails)', 'DENY', { auth: null, path: D + '/emailList/x', method: 'get' }),
  T('admin reads emailList', 'DENY', { auth: { uid: 'admin1' }, path: D + '/emailList/x', method: 'get' }, null, ADMIN),
  T('anon reads scoringEvents', 'DENY', { auth: null, path: D + '/scoringEvents/x', method: 'get' }),
  T('anon reads clientErrors', 'DENY', { auth: null, path: D + '/clientErrors/x', method: 'get' }),
  T('anon reads submissionAudits', 'DENY', { auth: null, path: D + '/submissionAudits/x', method: 'get' }),
  T('anon writes seasons', 'DENY', { auth: null, path: D + '/seasons/x', method: 'create', resource: { data: {} } }),
  T('admin writes seasons directly', 'DENY',
    { auth: { uid: 'admin1' }, path: D + '/seasons/x', method: 'create', resource: { data: {} } }, null, ADMIN),
  T('anon reads an unlisted collection', 'DENY', { auth: null, path: D + '/somethingNew/x', method: 'get' })
  ,
  // profile documents with only one of the three role fields (the bug the
  // map.get() fix addresses: a bare property read on a missing field errors)
  T('admin whose profile has ONLY isAdmin (no role field)', 'ALLOW',
    { auth: { uid: 'a2' }, path: D + '/config/champions', method: 'update', resource: { data: { te: 'Winner' } } },
    { data: { te: 'Old' } }, profileMock('a2', { isAdmin: true, linkedName: 'Boss2' })),
  T('admin whose profile has ONLY role=admin (no isAdmin)', 'ALLOW',
    { auth: { uid: 'a3' }, path: D + '/config/champions', method: 'update', resource: { data: { te: 'Winner' } } },
    { data: { te: 'Old' } }, profileMock('a3', { role: 'admin' })),
  T('player whose profile has ONLY linkedName writes checkin', 'DENY',
    { auth: { uid: 'p9' }, path: D + '/checkins/x', method: 'create', resource: { data: { player: 'X' } } },
    null, profileMock('p9', { linkedName: 'Nobody' })),
  T('player with only linkedName updates own prefs', 'ALLOW',
    { auth: { uid: 'p9' }, path: D + '/userProfiles/p9', method: 'update', resource: { data: { linkedName: 'Nobody', preferences: { newsletter: true } } } },
    { data: { linkedName: 'Nobody' } }, profileMock('p9', { linkedName: 'Nobody' }))
];

module.exports = { cases, D };
if (require.main === module) runOnRulesApi();

function runOnRulesApi() {
const RULES = fs.readFileSync(RULES_PATH, 'utf8');
const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const names = cases.map(c => c._name);
const apiCases = cases.map(c => { const copy = Object.assign({}, c); delete copy._name; return copy; });

const body = JSON.stringify({
  source: { files: [{ name: 'firestore.rules', content: RULES }] },
  testSuite: { testCases: apiCases }
});

fetch('https://firebaserules.googleapis.com/v1/projects/' + P + ':test', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'x-goog-user-project': P },
  body: body
}).then(r => r.json()).then(j => {
  if (j.error) { console.error('API error:', JSON.stringify(j.error, null, 2)); process.exit(1); }
  if (j.issues && j.issues.length) {
    console.log('=== COMPILE ISSUES ===');
    j.issues.forEach(i => console.log(' ' + i.severity + ' line ' + (i.sourcePosition && i.sourcePosition.line) + ': ' + i.description));
  }
  const res = j.testResults || [];
  let pass = 0, fail = 0;
  res.forEach((r, i) => {
    const ok = r.state === 'SUCCESS';
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + names[i]);
    if (!ok && r.debugMessages) r.debugMessages.slice(0, 2).forEach(m => console.log('        ' + m));
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + res.length + ' total');
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
}
