// Call updatePlayerEmail and adminEditGameRecord from functions/index.js
// against the Firestore emulator, with fake callers. Offline, no key, no
// live data. Needs Java 17+ for the emulator.
//
// Run from the app root:
//   firebase emulators:exec --only firestore --project demo-poker-test "node scripts/callables-emulator-test.js"
// Optional argument: a different functions folder to load (to show a case
// fails against older code).
const path = require('path');
const Module = require('module');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is not set; run this under firebase emulators:exec (see the header).');
  process.exit(1);
}
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-poker-test';
const PROJECT = process.env.GCLOUD_PROJECT;
const FUNCTIONS_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'functions'));

// The host assistant's model SDK is only needed when its callables run. A
// checkout whose committed node_modules predates it can still load index.js.
const fnRequire = Module.createRequire(path.join(FUNCTIONS_DIR, 'index.js'));
for (const optional of ['@anthropic-ai/sdk']) {
  try { fnRequire.resolve(optional); } catch (e) {
    const stubId = 'stub:' + optional;
    const stub = new Module(stubId);
    stub.filename = stubId;
    stub.loaded = true;
    stub.exports = class StubClient {};
    require.cache[stubId] = stub;
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      return request === optional ? stubId : resolve.call(this, request, ...rest);
    };
  }
}

const fns = fnRequire('./index.js');
const db = fnRequire('firebase-admin/firestore').getFirestore();

const clearAll = () => fetch(
  `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
  { method: 'DELETE' });

const caller = (uid, provider = 'google.com') => ({ uid, token: { email: uid + '@example.com', firebase: { sign_in_provider: provider } } });
const SIGNED_OUT = null;   // not undefined: that would trigger edit()'s default admin caller

async function call(name, data, auth) {
  if (typeof fns[name] !== 'function' || typeof fns[name].run !== 'function') {
    return { error: 'not-exported' };
  }
  try { return { result: await fns[name].run({ data, auth }) }; }
  catch (e) { return { error: e.code || e.message }; }
}

async function seed(docs) {
  const batch = db.batch();
  Object.entries(docs).forEach(([p, data]) => batch.set(db.doc(p), data));
  await batch.commit();
}
const read = async p => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

// ── updatePlayerEmail ────────────────────────────────────────────────────────
const PROFILES = {
  'userProfiles/linked1': { linkedName: 'Test Player' },
  'userProfiles/other1': { linkedName: 'Other Player' },
  'userProfiles/staff1': { role: 'staff' },
  'userProfiles/admin1': { role: 'admin' }
};
const STORED = Object.assign({
  'players/p1': { name: 'Test Player', nameLower: 'test player' },
  'playerContacts/p1': { email: 'kept@example.com' }
}, PROFILES);
const REPLACE = { player: 'Test Player', email: 'new@example.com', source: 'profile_edit' };

// The stored address survives. A signed-out or anonymous caller gets a normal
// reply that never echoes it; a signed-in caller who asked to replace gets
// permission-denied, so the profile page can say the change did not happen.
function keepsStored(label, auth, data = REPLACE, extra = {}) {
  return {
    name: label, seed: Object.assign({}, STORED, extra),
    run: () => call('updatePlayerEmail', data, auth),
    check: async r => {
      const contact = await read('playerContacts/p1');
      return r.result && contact && contact.email === 'kept@example.com'
        && r.result.email === null && r.result.preservedExisting === true;
    }
  };
}
function refused(label, auth, extra = {}) {
  return {
    name: label, seed: Object.assign({}, STORED, extra),
    run: () => call('updatePlayerEmail', REPLACE, auth),
    check: async r => r.error === 'permission-denied' && (await read('playerContacts/p1')).email === 'kept@example.com'
  };
}
function replaces(label, auth, extra = {}) {
  return {
    name: label, seed: Object.assign({}, STORED, extra),
    run: () => call('updatePlayerEmail', REPLACE, auth),
    check: async r => r.result && (await read('playerContacts/p1')).email === 'new@example.com'
      && r.result.email === 'new@example.com'
  };
}

const emailCases = [
  keepsStored('signed-out caller cannot replace a stored email', SIGNED_OUT),
  keepsStored('signed-out caller passing onlyIfMissing:false still cannot replace', SIGNED_OUT,
    Object.assign({ onlyIfMissing: false }, REPLACE)),
  keepsStored('anonymous account cannot replace a stored email', caller('anon1', 'anonymous')),
  refused('signed-in player linked to another name is refused', caller('other1')),
  refused('signed-in account with no profile is refused', caller('ghost')),
  refused('a contested claim (two profiles, one name) is refused', caller('linked1'),
    { 'userProfiles/linked2': { linkedName: 'Test Player' } }),
  refused('a lower-case variant of the name gets no authority', caller('variant1'),
    { 'userProfiles/variant1': { linkedName: 'test player' } }),
  refused('a trailing-space variant of the name gets no authority', caller('variant2'),
    { 'userProfiles/variant2': { linkedName: 'Test Player ' } }),
  replaces('a case variant claim does not block the exact claimant', caller('linked1'),
    { 'userProfiles/variant1': { linkedName: 'TEST PLAYER' } }),
  keepsStored('claiming a name (onlyIfMissing) on a player who has an email is not an error', caller('other1'),
    Object.assign({ onlyIfMissing: true }, REPLACE)),
  replaces('the linked player replaces their own email', caller('linked1')),
  replaces('staff replace a player email', caller('staff1')),
  replaces('an admin replaces a player email', caller('admin1')),
  {
    name: 'signed-out kiosk fills in an email for a player without one',
    seed: Object.assign({ 'players/p2': { name: 'New Player', nameLower: 'new player' } }, PROFILES),
    run: () => call('updatePlayerEmail', { player: 'New Player', email: 'fill@example.com' }, SIGNED_OUT),
    check: async r => r.result && (await read('playerContacts/p2')).email === 'fill@example.com'
  },
  {
    name: 'signed-out caller cannot replace a legacy players.email (it is backfilled instead)',
    seed: Object.assign({ 'players/p3': { name: 'Legacy Player', nameLower: 'legacy player', email: 'legacy@example.com' } }, PROFILES),
    run: () => call('updatePlayerEmail', { player: 'Legacy Player', email: 'new@example.com' }, SIGNED_OUT),
    check: async r => r.result && (await read('playerContacts/p3')).email === 'legacy@example.com' && r.result.email === null
  },
  {
    name: 'a non-string email is rejected as invalid-argument',
    seed: PROFILES,
    run: () => call('updatePlayerEmail', { player: 'Test Player', email: { $gt: '' } }, caller('admin1')),
    check: async r => r.error === 'invalid-argument'
  },

  // emailSignup (home.html landing form, signed out) matches a name to the
  // roster the same way; it may fill a missing contact email, never replace.
  {
    name: 'emailSignup cannot replace a stored contact email',
    seed: STORED,
    run: () => call('emailSignup', { name: 'Test Player', email: 'signup@example.com' }, SIGNED_OUT),
    check: async r => r.result && r.result.status === 'subscribed'
      && (await read('playerContacts/p1')).email === 'kept@example.com'
  },
  {
    name: 'emailSignup cannot replace a legacy players.email',
    seed: Object.assign({ 'players/p3': { name: 'Legacy Player', nameLower: 'legacy player', email: 'legacy@example.com' } }, PROFILES),
    run: () => call('emailSignup', { name: 'Legacy Player', email: 'signup@example.com' }, SIGNED_OUT),
    check: async r => r.result && (await read('playerContacts/p3')).email === 'legacy@example.com'
  },
  {
    name: 'emailSignup fills in a contact email for a matched player without one',
    seed: Object.assign({ 'players/p2': { name: 'New Player', nameLower: 'new player' } }, PROFILES),
    run: () => call('emailSignup', { name: 'New Player', email: 'signup@example.com' }, SIGNED_OUT),
    check: async r => r.result && r.result.status === 'linked'
      && (await read('playerContacts/p2')).email === 'signup@example.com'
  }
];

// ── adminEditGameRecord ──────────────────────────────────────────────────────
const GAME = { venue: 'Tight End', date: '10/19/2026', gameNum: 1 };
const ROWS = Object.assign({
  'checkins/c1': Object.assign({ player: 'Test Player' }, GAME),
  'eliminations/e1': Object.assign({ player: 'Test Player', rank: 3, bonusPoints: 80 }, GAME),
  'bounties/b1': Object.assign({ player: 'Test Player', count: 2 }, GAME),
  'eliminations/eOther': Object.assign({ player: 'Other Player', rank: 1, bonusPoints: 90 }, GAME),
  'checkins/cOtherGame': Object.assign({}, GAME, { player: 'Test Player', gameNum: 2 })
}, PROFILES);
const edit = (data, auth = caller('admin1')) =>
  call('adminEditGameRecord', Object.assign({}, GAME, { player: 'Test Player' }, data), auth);

const eliminationsFor = async name => (await db.collection('eliminations').where('player', '==', name).get()).size;
const bountiesFor = async name => (await db.collection('bounties').where('player', '==', name).get()).size;

const inspectorCases = [
  {
    // game-inspector.html mints the new row's id before calling, so a second
    // quick edit carries the same id; the server must create one row, not two.
    name: 'two quick rank edits with the page-minted id leave one elimination row', seed: ROWS,
    run: () => Promise.all([
      call('adminEditGameRecord', Object.assign({}, GAME, { op: 'setRank', player: 'New Player', elimId: 'eMinted', rank: 2 }), caller('admin1')),
      call('adminEditGameRecord', Object.assign({}, GAME, { op: 'setRank', player: 'New Player', elimId: 'eMinted', rank: 4 }), caller('admin1'))
    ]),
    check: async r => r.every(x => x.result && x.result.elimId === 'eMinted') && (await eliminationsFor('New Player')) === 1
  },
  {
    name: 'two quick bounty edits with the page-minted id leave one bounty row', seed: ROWS,
    run: () => Promise.all([
      call('adminEditGameRecord', Object.assign({}, GAME, { op: 'setBounty', player: 'New Player', bountyId: 'bMinted', count: 1 }), caller('admin1')),
      call('adminEditGameRecord', Object.assign({}, GAME, { op: 'setBounty', player: 'New Player', bountyId: 'bMinted', count: 2 }), caller('admin1'))
    ]),
    check: async r => r.every(x => x.result && x.result.bountyId === 'bMinted') && (await bountiesFor('New Player')) === 1
  },
  // The page side (ids minted before the call, cleared at once on a clear,
  // replies in any order) is run directly by scripts/game-inspector-edit-test.js.
  {
    name: 'signed-out caller cannot edit a game record', seed: ROWS,
    run: () => edit({ op: 'removePlayer', checkinId: 'c1' }, SIGNED_OUT),
    check: async r => r.error === 'unauthenticated' && !!(await read('checkins/c1'))
  },
  {
    name: 'staff cannot edit a game record (admin only, as the page was)', seed: ROWS,
    run: () => edit({ op: 'removePlayer', checkinId: 'c1' }, caller('staff1')),
    check: async r => r.error === 'permission-denied' && !!(await read('checkins/c1'))
  },
  {
    name: 'admin sets a rank: same fields the page wrote, bonus from the points table', seed: ROWS,
    run: () => edit({ op: 'setRank', elimId: 'e1', rank: 1 }),
    check: async r => {
      const e = await read('eliminations/e1');
      return r.result && r.result.elimId === 'e1' && e.rank === 1 && e.bonusPoints === 90 && e.venue === 'Tight End';
    }
  },
  {
    name: 'admin ranks a player with no elimination row: one is created', seed: ROWS,
    run: () => call('adminEditGameRecord', Object.assign({}, GAME, { op: 'setRank', player: 'New Player', rank: 10 }), caller('admin1')),
    check: async r => {
      const e = r.result && await read('eliminations/' + r.result.elimId);
      return !!e && e.player === 'New Player' && e.rank === 10 && e.bonusPoints === 10 && e.gameNum === 1;
    }
  },
  {
    name: 'admin clears a rank: the elimination row is deleted', seed: ROWS,
    run: () => edit({ op: 'setRank', elimId: 'e1', rank: null }),
    check: async r => r.result && r.result.elimId === null && !(await read('eliminations/e1'))
  },
  {
    name: 'admin sets a bounty count', seed: ROWS,
    run: () => edit({ op: 'setBounty', bountyId: 'b1', count: 5 }),
    check: async r => r.result && r.result.bountyId === 'b1' && (await read('bounties/b1')).count === 5
  },
  {
    name: 'admin sets a bounty count to 0: the row is deleted', seed: ROWS,
    run: () => edit({ op: 'setBounty', bountyId: 'b1', count: 0 }),
    check: async r => r.result && r.result.bountyId === null && !(await read('bounties/b1'))
  },
  {
    name: 'admin removes a player: checkin, elimination and bounty go together', seed: ROWS,
    run: () => edit({ op: 'removePlayer', checkinId: 'c1', elimId: 'e1', bountyId: 'b1' }),
    check: async r => r.result && r.result.removed === 3
      && !(await read('checkins/c1')) && !(await read('eliminations/e1')) && !(await read('bounties/b1'))
  },
  {
    name: 'admin adds a player: a checkin marked addedByAdmin', seed: ROWS,
    run: () => call('adminEditGameRecord', Object.assign({}, GAME, { op: 'addPlayer', player: 'New Player' }), caller('admin1')),
    check: async r => {
      const c = r.result && await read('checkins/' + r.result.checkinId);
      return !!c && c.player === 'New Player' && c.addedByAdmin === true && c.date === '10/19/2026';
    }
  },
  {
    name: "an id from another player's row is refused, nothing deleted", seed: ROWS,
    run: () => edit({ op: 'removePlayer', checkinId: 'c1', elimId: 'eOther' }),
    check: async r => r.error === 'failed-precondition' && !!(await read('checkins/c1')) && !!(await read('eliminations/eOther'))
  },
  {
    name: "an id from another game's row is refused", seed: ROWS,
    run: () => edit({ op: 'removePlayer', checkinId: 'cOtherGame' }),
    check: async r => r.error === 'failed-precondition' && !!(await read('checkins/cOtherGame'))
  },
  {
    name: 'a rank outside 1 to 10 is refused', seed: ROWS,
    run: () => edit({ op: 'setRank', elimId: 'e1', rank: 11 }),
    check: async r => r.error === 'invalid-argument' && (await read('eliminations/e1')).rank === 3
  }
];

(async () => {
  console.log('functions: ' + FUNCTIONS_DIR);
  let pass = 0, fail = 0;
  for (const c of emailCases.concat(inspectorCases)) {
    await clearAll();
    await seed(c.seed);
    const r = await c.run();
    let ok = false;
    try { ok = !!(await c.check(r)); } catch (e) { ok = false; }
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + c.name + (ok ? '' : '  -> ' + JSON.stringify(r)));
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
