#!/usr/bin/env node
// Generated demo data for the poker club app. Every name, game, score and
// address here is invented by a seeded generator: nothing is copied from the
// live club. The same seed always produces byte-identical output.
//
//   node demo/seed.js --out demo/fixtures   write one JSON file per collection
//   node demo/seed.js --load                load the Firestore and Auth emulators
//                                           (FIRESTORE_EMULATOR_HOST and
//                                           FIREBASE_AUTH_EMULATOR_HOST must be set;
//                                           `firebase emulators:start` sets neither
//                                           for other shells, so pass them in)
//
// Optional: ROSTER_EXPORT=<file> (one real name per line, kept outside the
// repo) makes the run fail if any generated name matches a real one.

'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT = 'demo-poker';
const DEMO_TODAY = '2026-10-20'; // the "current" night the demo is frozen at
const VENUES = [
  { name: 'Tight End', weekday: 2 },   // Tuesdays
  { name: 'Wild Corgi', weekday: 4 }   // Thursdays
];
const BONUS_POINTS = { 1: 90, 2: 85, 3: 80, 4: 70, 5: 60, 6: 50, 7: 40, 8: 30, 9: 20, 10: 10 };

// ── deterministic random numbers (mulberry32) ────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261022);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ── names: common first names, invented surnames ────────────────────────────
const FIRST = ['Alex', 'Bailey', 'Casey', 'Dana', 'Eli', 'Frankie', 'Gray', 'Harper', 'Indy', 'Jordan',
  'Kai', 'Logan', 'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Riley', 'Sage', 'Tatum',
  'Uma', 'Val', 'Wren', 'Yael', 'Zion', 'Rowan', 'Emery', 'Remy', 'Shay', 'Avery',
  'Blake', 'Cameron', 'Drew', 'Ellis', 'Finley', 'Hayden', 'Jesse', 'Kendall', 'Lane', 'Marlow'];
const LAST = ['Ashgrove', 'Brindlewood', 'Corrimore', 'Dellacourt', 'Embervale', 'Fenwhistle', 'Gallowpike',
  'Hollowmere', 'Inglebrook', 'Juniperhart', 'Kestrelton', 'Larkspurne', 'Marlowind', 'Nettlefield',
  'Orrinsby', 'Pellbrook', 'Quillfeather', 'Rastervale', 'Sablewood', 'Tamberline', 'Umberhill',
  'Vossington', 'Wexmoor', 'Yarrowdale', 'Zephyrine', 'Thistlecombe', 'Brackenridge-Vale', 'Coldharbour',
  'Duskwater', 'Everhollow'];

function makeRoster() {
  const used = new Set();
  const names = [];
  while (names.length < 150) {
    const n = `${pick(FIRST)} ${pick(LAST)}`;
    if (!used.has(n.toLowerCase())) { used.add(n.toLowerCase()); names.push(n); }
  }
  // Deliberately messy rows, because the search, sweep and merge code exists for them.
  const messy = [
    names[0].toLowerCase(),                         // case variant of a regular
    names[1].replace(' ', '  '),                    // whitespace variant
    names[2].split(' ')[0],                         // first-name-only duplicate
    `${names[3].split(' ')[0]} ${names[3].split(' ')[1][0]}`, // one-letter surname
    `${names[4].split(' ')[0]} ${names[4].split(' ')[1][0]}`, // a second one-letter surname
    names[5].slice(0, -1),                          // typo
    'test', 'asdf'                                  // junk rows
  ];
  return { names, messy, aliases: { [names[6]]: [names[6].split(' ')[0] + 'y'] } };
}

// ── dates ────────────────────────────────────────────────────────────────────
function parseIso(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function iso(d) { return d.toISOString().slice(0, 10); }
function mdy(d) { return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; }
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function eventKey(date, venue) { // mirrors normalizeEventKey in functions/index.js
  const [m, d, y] = date.split('/');
  const v = venue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}_${v}`;
}
function firstWeekday(fromIso, weekday) {
  let d = parseIso(fromIso);
  while (d.getUTCDay() !== weekday) d = addDays(d, 1);
  return d;
}
function stamp(date, hour, minute) { // a fixed ISO time on that night, Mountain time (UTC-6 in this season)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour + 6, minute)).toISOString();
}

// ── scoring, mirroring calculateTiePoints in functions/index.js ─────────────
function tiePoints(rank, numTied) {
  if (rank > 10) return 0;
  let total = 0;
  for (let r = rank; r < rank + numTied && r <= 10; r++) total += BONUS_POINTS[r] || 0;
  return Math.ceil(total / numTied / 5) * 5;
}

function build() {
  const { names, messy, aliases } = makeRoster();
  const out = {
    players: {}, playerContacts: {}, seasons: {}, schedule: {}, eventContent: {}, checkins: {},
    eliminations: {}, bounties: {}, rsvps: {}, champ_overrides: {}, announcements: {},
    shotRounds: {}, shotOptions: {}, timerClocks: {}, userProfiles: {}
  };
  let seq = 0;
  const id = (prefix) => `${prefix}-${String(++seq).padStart(5, '0')}`;

  // Players: 40 regulars, 90 occasional, 20 imported but never seen, plus the messy rows.
  const regulars = names.slice(0, 40), occasional = names.slice(40, 130), neverSeen = names.slice(130);
  [...names, ...messy].forEach((n, i) => {
    const doc = { name: n, nameLower: n.toLowerCase(), createdAt: '2026-01-15T18:00:00.000Z' };
    if (aliases[n]) doc.aliases = aliases[n];
    if (neverSeen.includes(n)) doc.addedVia = 'import';
    const pid = `player-${String(i + 1).padStart(4, '0')}`;
    out.players[pid] = doc;
    if (i % 10 === 3 && !messy.includes(n)) {
      const local = n.toLowerCase().replace(/[^a-z]+/g, '.');
      out.playerContacts[pid] = { email: `${local}@example.com`, emailAddedAt: '2026-02-01T18:00:00.000Z', source: 'landing_page' };
    }
  });

  const seasonDefs = [];
  VENUES.forEach((v, vi) => {
    const closedStart = firstWeekday('2026-06-29', v.weekday);
    const liveStart = firstWeekday('2026-08-24', v.weekday);
    seasonDefs.push({ venue: v.name, name: 'Summer 2026', number: 1, start: closedStart, weeks: 6, closed: true });
    seasonDefs.push({ venue: v.name, name: 'Fall 2026', number: 2, start: liveStart, weeks: 12, closed: false });
  });

  for (const s of seasonDefs) {
    const end = addDays(s.start, 7 * (s.weeks - 1));
    const champ = addDays(end, 7);
    out.seasons[id('season')] = {
      // `active` is what scripts/season_health.py selects on; the admin season
      // editor does not write it, so a real season needs it set by hand.
      active: !s.closed,
      name: s.name, venue: s.venue, seasonNumber: s.number,
      startDate: mdy(s.start), endDate: mdy(end), championshipDate: mdy(champ),
      updatedAt: '2026-06-01T18:00:00.000Z'
    };
    const nights = [];
    for (let w = 0; w < s.weeks; w++) nights.push({ date: addDays(s.start, 7 * w), type: 'Regular' });
    nights.push({ date: champ, type: 'Championship' });
    for (const night of nights) {
      const date = mdy(night.date);
      const key = eventKey(date, s.venue);
      out.schedule[key] = { date, venue: s.venue, location: s.venue, type: night.type, theme: '', gearDescription: '', announcementNote: '', updatedAt: '2026-06-01T18:00:00.000Z' };
      if (iso(night.date) > DEMO_TODAY) continue; // future nights are scheduled, not played
      if (night.type === 'Championship') { championshipNight(out, id, date, s.venue, night.date); continue; }
      const isLatest = iso(night.date) === DEMO_TODAY;
      for (const gameNum of [1, 2]) {
        playGame(out, id, { date, venue: s.venue, gameNum, night: night.date, regulars, occasional,
          finalized: !(isLatest && gameNum === 2) });
      }
      if (rand() < 0.4) out.eventContent[key] = { date, venue: s.venue, description: 'Two games tonight. Doors at 6:30, cards in the air at 7.', updatedAt: '2026-06-01T18:00:00.000Z' };
    }
  }

  // One attendance credit on a finalized night (the late-credit path).
  const creditDate = mdy(firstWeekday('2026-09-29', 2));
  out.checkins[id('checkin')] = { player: occasional[0], playerLower: occasional[0].toLowerCase(), date: creditDate, gameNum: 1, venue: 'Tight End', status: 'checked-in', attendanceOnly: true, manuallyAdded: true, createdAt: '2026-10-01T02:00:00.000Z' };

  out.announcements[id('announcement')] = { title: 'Fall championship dates are set', body: 'Both venues hold their championship the week after the last regular night.', createdAt: '2026-10-01T18:00:00.000Z' };

  // Shot rounds on the demo night: one in each state the bar board shows.
  const latest = parseIso(DEMO_TODAY);
  const drinks = ['House', 'Tequila', 'Pickle', 'Lemon drop'];
  const tables = ['hearts', 'diamonds', 'clubs', 'spades'];
  const states = [
    { status: 'draft' }, { status: 'pending' }, { status: 'pending', poured: true },
    { status: 'closed', poured: true, paid: true }
  ];
  states.forEach((st, i) => {
    const who = shuffle(regulars).slice(0, between(1, 4));
    out.shotRounds[id('shots')] = {
      venue: 'Tight End', eventType: 'Regular', gameNum: 2, gameLabel: 'Game 2', sessionDate: mdy(latest),
      table: tables[i], submitter: { name: who[0] },
      players: who.map(n => ({ name: n, payment: rand() < 0.5 ? 'cash' : 'card', shots: [{ type: pick(drinks), qty: 1 }] })),
      clientId: `demo-client-${i + 1}`, timestamp: stamp(latest, 21, 5 + i * 3), submittedAt: stamp(latest, 21, 5 + i * 3),
      updatedAt: stamp(latest, 21, 6 + i * 3), poured: !!st.poured, paid: !!st.paid, status: st.status
    };
  });
  drinks.forEach((d) => { out.shotOptions[d.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = { name: d, count: 0 }; });

  // Two venue clocks (one running, one paused) and one home-game clock.
  const game = (status, levelIndex, remainingMs) => ({ status, levelIndex, remainingMs, anchorAt: Date.parse(stamp(latest, 21, 0)), changedAt: Date.parse(stamp(latest, 21, 0)) });
  out.timerClocks.tight = { venue: 'Tight End', name: 'Tight End', structure: 'standard', sound: 'voice', games: { 1: game('running', 6, 540000), 2: game('paused', 2, 900000) }, updatedAt: stamp(latest, 21, 0) };
  out.timerClocks.corgi = { venue: 'Wild Corgi', name: 'Wild Corgi', structure: 'standard', sound: 'voice', games: { 1: game('paused', 0, 1200000), 2: game('paused', 0, 1200000) }, updatedAt: stamp(latest, 21, 0) };
  out.timerClocks['sams-house-k3x9q2'] = { name: "Sam's house", structure: 'standard', sound: 'chime', games: { 1: game('paused', 0, 1200000) }, updatedAt: stamp(latest, 21, 0) };

  // Demo accounts. Auth users are created by --load; these profiles use fixed uids.
  out.userProfiles['demo-admin'] = { role: 'admin', email: 'admin@example.com' };
  out.userProfiles['demo-staff'] = { role: 'staff', email: 'staff@example.com' };
  out.userProfiles['demo-player'] = { linkedName: regulars[0], email: 'player@example.com' };
  return { out, allNames: [...names, ...messy] };
}

function playGame(out, id, g) {
  const { date, venue, gameNum, night, regulars, occasional, finalized } = g;
  const target = between(gameNum === 1 ? 26 : 18, gameNum === 1 ? 44 : 34);
  const field = [];
  for (const n of shuffle(regulars)) if (field.length < target && rand() < 0.72) field.push(n);
  for (const n of shuffle(occasional)) if (field.length < target && rand() < 0.14) field.push(n);
  while (field.length < 18) { const n = pick(occasional); if (!field.includes(n)) field.push(n); }
  const base = { date, gameNum, venue };

  // Placements: ten finishers, with a two-way tie in about one game in three.
  const order = shuffle(field).slice(0, 10);
  const ranks = [];
  let r = 1;
  const tieAt = rand() < 0.35 ? between(2, 8) : 0;
  for (let i = 0; i < order.length && r <= 10; i++) {
    if (r === tieAt && i + 1 < order.length) { ranks.push([order[i], r], [order[i + 1], r]); i++; r += 2; }
    else { ranks.push([order[i], r]); r += 1; }
  }
  const placed = new Set(ranks.map(([n]) => n.toLowerCase()));
  const tied = {};
  ranks.forEach(([, rk]) => { tied[rk] = (tied[rk] || 0) + 1; });

  field.forEach((n, i) => {
    out.checkins[id('checkin')] = { ...base, player: n, playerLower: n.toLowerCase(), gameType: 'Regular', status: 'active',
      createdAt: stamp(night, gameNum === 1 ? 18 : 20, 30 + (i % 25)),
      ...(finalized && !placed.has(n.toLowerCase()) ? { attendanceOnly: true } : {}) };
  });
  ranks.forEach(([n, rk]) => {
    out.eliminations[id('elim')] = { ...base, player: n, playerLower: n.toLowerCase(), rank: rk, gameType: 'Regular',
      bonusPoints: finalized ? tiePoints(rk, tied[rk]) : null, ...(finalized ? { numTied: tied[rk] } : {}),
      status: finalized ? 'processed' : 'active', createdAt: stamp(night, gameNum === 1 ? 20 : 22, rk) };
  });
  // Bounties: about one per player knocked out, and nobody holds more than half.
  let left = field.length - 1;
  const hunters = shuffle(field).slice(0, between(5, 9));
  const counts = {};
  while (left > 0) { const h = pick(hunters); if ((counts[h] || 0) < Math.floor(field.length / 2)) { counts[h] = (counts[h] || 0) + 1; left--; } }
  Object.keys(counts).sort().forEach((n) => {
    out.bounties[id('bounty')] = { ...base, player: n, playerLower: n.toLowerCase(), count: counts[n], status: finalized ? 'processed' : 'active', createdAt: stamp(night, gameNum === 1 ? 20 : 22, 30) };
  });
  // RSVPs: most converted on arrival, some declined, a few no-shows left active.
  shuffle(regulars).slice(0, between(8, 16)).forEach((n) => {
    const status = field.includes(n) ? 'converted' : (rand() < 0.5 ? 'declined' : 'active');
    out.rsvps[id('rsvp')] = { ...base, player: n, playerLower: n.toLowerCase(), status, createdAt: stamp(addDays(night, -1), 12, between(0, 59)) };
  });
}

// Championship night, as it looks with the doors open: the season's top 20 hold
// the seats, 18 of them have checked in and 2 have RSVP'd, five alternates have
// checked in, and the director has sent one alternate to consolation.
function championshipNight(out, id, date, venue, night) {
  // Season points, as the leaderboard counts them: placement points, plus 10
  // for each attendance-only check-in. Rows so far at this venue are this season's.
  const points = {}, names = {};
  for (const e of Object.values(out.eliminations)) {
    if (e.venue !== venue || e.status !== 'processed') continue;
    points[e.playerLower] = (points[e.playerLower] || 0) + (e.bonusPoints || 0);
    names[e.playerLower] = e.player;
  }
  for (const c of Object.values(out.checkins)) {
    if (c.venue !== venue || c.attendanceOnly !== true) continue;
    points[c.playerLower] = (points[c.playerLower] || 0) + 10;
    names[c.playerLower] = c.player;
  }
  // Game 1 of the night ranks by season bounties, game 2 by points; the regulars
  // near the top of either list are the ones who come out.
  const bounties = {};
  for (const b of Object.values(out.bounties)) {
    if (b.venue === venue) { bounties[b.playerLower] = (bounties[b.playerLower] || 0) + b.count; names[b.playerLower] = b.player; }
  }
  const byDesc = (score) => Object.keys(score).sort((a, b) => score[b] - score[a] || a.localeCompare(b)).map(k => names[k]);
  const ranked = byDesc(points);
  const top20 = ranked.slice(0, 20), alternates = ranked.slice(20, 25);
  const rsvpOnly = new Set([top20[6], top20[14]]);
  const base = { date, gameNum: 1, venue };
  const arriving = [...new Set([...top20, ...byDesc(bounties).slice(0, 20), ...alternates])];
  arriving.filter(n => !rsvpOnly.has(n)).forEach((n, i) => {
    out.checkins[id('checkin')] = { ...base, player: n, playerLower: n.toLowerCase(), gameType: 'Championship', status: 'active', createdAt: stamp(night, 18, 30 + i) };
  });
  rsvpOnly.forEach((n) => {
    out.rsvps[id('rsvp')] = { ...base, player: n, playerLower: n.toLowerCase(), status: 'active', createdAt: stamp(addDays(night, -1), 12, 0) };
  });
  const docId = (venue + '_' + date).replace(/[\s\/]/g, '_');
  out.champ_overrides[docId] = { venue, date, updatedAt: stamp(night, 18, 0), [`g1_${alternates[4].toLowerCase()}`]: 'consolation' };
}

// ── output ───────────────────────────────────────────────────────────────────
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

function collisionCheck(allNames) {
  const file = process.env.ROSTER_EXPORT;
  if (!file) { console.log('collision check: skipped (set ROSTER_EXPORT to a file of real names, one per line)'); return; }
  const real = new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean));
  const hits = allNames.filter(n => real.has(n.trim().replace(/\s+/g, ' ').toLowerCase()));
  console.log(`collision check: ${hits.length} generated name(s) match the roster export`);
  if (hits.length) process.exit(1);
}

function toValue(v) { // JSON value -> Firestore REST value
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) ? { timestampValue: v } : { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
}

async function load(out) {
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST, authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!fsHost || !authHost) { console.error('Set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST (for example 127.0.0.1:8080 and 127.0.0.1:9099).'); process.exit(2); }
  const accounts = { 'demo-admin': 'admin@example.com', 'demo-staff': 'staff@example.com', 'demo-player': 'player@example.com' };
  for (const [uid, email] of Object.entries(accounts)) {
    const res = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: uid, email, password: 'demo-password', emailVerified: true })
    });
    if (!res.ok && res.status !== 400) throw new Error(`auth emulator: ${res.status} ${await res.text()}`);
  }
  let n = 0;
  for (const [coll, docs] of Object.entries(out)) {
    for (const [docId, data] of Object.entries(docs)) {
      const url = `http://${fsHost}/v1/projects/${PROJECT}/databases/(default)/documents/${coll}/${encodeURIComponent(docId)}`;
      const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify({ fields: toValue(data).mapValue.fields }) });
      if (!res.ok) throw new Error(`firestore emulator: ${coll}/${docId}: ${res.status} ${await res.text()}`);
      n++;
    }
  }
  console.log(`loaded ${n} documents into project ${PROJECT}`);
  console.log('demo sign-ins (emulator only): admin@example.com, staff@example.com, player@example.com; password demo-password');
}

async function main() {
  const { out, allNames } = build();
  collisionCheck(allNames);
  const outIdx = process.argv.indexOf('--out');
  if (outIdx > -1) {
    const dir = path.resolve(process.argv[outIdx + 1] || 'demo/fixtures');
    fs.mkdirSync(dir, { recursive: true });
    for (const [coll, docs] of Object.entries(out)) fs.writeFileSync(path.join(dir, `${coll}.json`), JSON.stringify(sortKeys(docs), null, 1) + '\n');
    const counts = Object.entries(out).map(([c, d]) => `${c} ${Object.keys(d).length}`).join(', ');
    console.log(`wrote ${Object.keys(out).length} collections to ${path.relative(process.cwd(), dir)}: ${counts}`);
  }
  if (process.argv.includes('--load')) await load(out);
  if (outIdx === -1 && !process.argv.includes('--load')) console.log('nothing to do: pass --out <dir> or --load');
}

module.exports = { build, sortKeys, FIRST, LAST };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
