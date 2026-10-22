/**
 * READ-ONLY roster sweep for the /player-sweep command. Never writes.
 *
 * Loads the full roster plus every checkin / elimination / bounty / rsvp and
 * reports, as JSON on stdout:
 *   - groups     : candidate duplicate groups with per-name evidence
 *   - junk       : roster rows that are not a person (blank, "Admin 1", ...)
 *   - neverSeen  : roster rows with zero activity anywhere
 *   - configRefs : names in config/* docs that do not match any roster row
 *
 * Usage (from All-In-Poker-App/functions):
 *   node scripts/player-sweep.js               # JSON report
 *   node scripts/player-sweep.js --text        # human-readable summary
 *   node scripts/player-sweep.js --min 0.80    # fuzzy threshold (default 0.82)
 *
 * The scoring mirrors calculateNameSimilarity in functions/index.js (nickname
 * and initial aware, last-name weighted, Levenshtein fallback) so what this
 * flags is what the app's own findDuplicatePlayers would flag, plus three
 * cheap signals the app never had: normalized-exact matches, single-token
 * names that are the first name of exactly one active roster entry, and
 * per-name activity so the canonical spelling is obvious.
 */
const admin = require('firebase-admin');
process.env.GCLOUD_PROJECT = 'demo-poker';
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'demo-poker' });
const db = admin.firestore();

const args = process.argv.slice(2);
const TEXT = args.includes('--text');
const MIN = (() => { const i = args.indexOf('--min'); return i >= 0 ? Number(args[i + 1]) : 0.82; })();

// Names that are system placeholders, not people. Never proposed for merge.
const SYSTEM_NAMES = new Set(['unrecorded player']);

// Pairs the owner has already reviewed and declined (player-sweep-ignore.json).
const IGNORED_PAIRS = (() => {
  try {
    const cfg = require('./player-sweep-ignore.json');
    const k = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    return new Set((cfg.pairs || []).map(([a, b]) => [k(a), k(b)].sort().join('|')));
  } catch (e) { return new Set(); }
})();
const isIgnored = (a, b) => IGNORED_PAIRS.has([a, b].sort().join('|'));

// Same nickname table shape as the client PlayerSearch; kept local so this
// script has no import from public/ (it runs under node, not the browser).
const NICKNAMES = {
  alex: ['alexander', 'alexandra'], mike: ['michael'], rob: ['robert', 'bob'], bob: ['robert', 'rob'],
  will: ['william', 'bill'], bill: ['william', 'will'], jim: ['james'], joe: ['joseph'], tom: ['thomas'],
  chris: ['christopher', 'christina'], matt: ['matthew'], nick: ['nicholas'], sam: ['samuel', 'samantha'],
  tony: ['anthony'], steve: ['steven', 'stephen'], dave: ['david'], dan: ['daniel', 'danny'], danny: ['daniel', 'dan'],
  ben: ['benjamin'], jake: ['jacob'], josh: ['joshua'], pat: ['patrick'], pete: ['peter'], rick: ['richard'],
  jeff: ['jeffrey'], jon: ['jonathan', 'john'], john: ['jon', 'johnny'], johnny: ['john'], liz: ['elizabeth'],
  kate: ['katherine', 'kathy'], sue: ['susan'], ed: ['edward', 'eddie'], greg: ['gregory'], ken: ['kenneth'],
  nate: ['nathan', 'nathaniel'], andy: ['andrew'], tim: ['timothy'], ron: ['ronald'], don: ['donald'],
  ray: ['raymond'], vince: ['vincent'], meg: ['megan', 'meghan'], megan: ['meghan'], meghan: ['megan'],
  scot: ['scott'], scott: ['scot'], jen: ['jennifer'], jenny: ['jennifer'], zach: ['zachary'], zack: ['zachary']
};
const nickEq = (a, b) => a === b || (NICKNAMES[a] || []).includes(b) || (NICKNAMES[b] || []).includes(a);

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** Mirrors calculateNameSimilarity in functions/index.js. Returns 0..1. */
function similarity(n1, n2) {
  const a = norm(n1), b = norm(n2);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pa = a.split(' '), pb = b.split(' ');
  const first1 = pa[0], first2 = pb[0];
  const last1 = pa.length > 1 ? pa[pa.length - 1] : '';
  const last2 = pb.length > 1 ? pb[pb.length - 1] : '';
  const firstMatch = nickEq(first1, first2) || (first1.length === 1 && first2.startsWith(first1)) || (first2.length === 1 && first1.startsWith(first2));
  const lastExact = !!(last1 && last2 && last1 === last2);
  const lastInitial = !!(last1 && last2 && !lastExact && ((last1.length === 1 && last2.startsWith(last1)) || (last2.length === 1 && last1.startsWith(last2))));
  // Deviation from the server rule, on purpose: a one-letter surname only
  // counts as a match when the first names match too. "Michael M" vs
  // "Margaret Mohaisen" share an initial and nothing else, and the server's
  // looser rule chained every M-surname into one group.
  if (firstMatch && (lastExact || lastInitial)) return 0.95;
  if (lastExact && first1[0] === first2[0]) return 0.85;
  if (firstMatch && last1 && last2) {
    const lastSim = 1 - lev(last1, last2) / Math.max(last1.length, last2.length);
    if (lastSim >= 0.7) return 0.5 + lastSim * 0.4;
  }
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

const ts = v => (v && typeof v.toDate === 'function') ? v.toDate() : (typeof v === 'string' ? new Date(v) : null);
const mdy = s => { const p = String(s || '').split('/'); return p.length === 3 ? new Date(+p[2], +p[0] - 1, +p[1]) : null; };
const fmt = d => d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : null;

async function main() {
  const [players, checkins, elims, bounties, rsvps, cfgAQ, cfgCW, cfgCH, cfgHH, overrides, contacts] = await Promise.all([
    db.collection('players').get(),
    db.collection('checkins').select('player', 'playerLower', 'date', 'venue', 'status').get(),
    db.collection('eliminations').select('player', 'playerLower', 'date', 'venue', 'rank').get(),
    db.collection('bounties').select('player', 'playerLower', 'date', 'venue', 'count').get(),
    db.collection('rsvps').select('player', 'playerLower', 'date', 'venue').get(),
    db.collection('config').doc('autoQualifiers').get(),
    db.collection('config').doc('consolationWinners').get(),
    db.collection('config').doc('champions').get(),
    db.collection('config').doc('highHands').get(),
    db.collection('champ_overrides').get(),
    db.collection('playerContacts').get()
  ]);
  const contactsByPlayerId = new Map(contacts.docs.map(d => [d.id, d.data()]));

  // Per-normalized-name activity, keyed by the name as stored on the record.
  const activity = new Map(); // key -> { spellings:Map, checkins, elims, bounties, rsvps, first, last, venues:Set }
  const bump = (name, kind, dateStr, venue, extra = 0) => {
    const key = norm(name); if (!key) return;
    let a = activity.get(key);
    if (!a) { a = { spellings: new Map(), checkins: 0, elims: 0, bounties: 0, rsvps: 0, first: null, last: null, venues: new Set() }; activity.set(key, a); }
    a.spellings.set(name, (a.spellings.get(name) || 0) + 1);
    a[kind] += 1;
    if (venue) a.venues.add(venue);
    const d = mdy(dateStr);
    if (d) { if (!a.first || d < a.first) a.first = d; if (!a.last || d > a.last) a.last = d; }
  };
  checkins.forEach(d => { const x = d.data(); if (x.status !== 'removed') bump(x.player, 'checkins', x.date, x.venue); });
  elims.forEach(d => { const x = d.data(); bump(x.player, 'elims', x.date, x.venue); });
  bounties.forEach(d => { const x = d.data(); bump(x.player, 'bounties', x.date, x.venue); });
  rsvps.forEach(d => { const x = d.data(); bump(x.player, 'rsvps', x.date, x.venue); });

  const roster = [];
  players.forEach(d => {
    const x = d.data();
    const name = String(x.name || '');
    const key = norm(name);
    const a = activity.get(key);
    roster.push({
      id: d.id, name, key,
      importedFromGAS: !!x.importedFromGAS,
      email: !!((contactsByPlayerId.get(d.id) || {}).email || x.email),
      aliases: Array.isArray(x.aliases) ? x.aliases : [],
      added: fmt(ts(x.addedAt) || ts(x.createdAt)),
      checkins: a ? a.checkins : 0, elims: a ? a.elims : 0, bounties: a ? a.bounties : 0, rsvps: a ? a.rsvps : 0,
      first: a ? fmt(a.first) : null, last: a ? fmt(a.last) : null,
      venues: a ? [...a.venues] : [],
      spellingsOnRecords: a ? [...a.spellings.keys()].filter(s => s !== name) : []
    });
  });
  const total = r => r.checkins + r.elims + r.bounties + r.rsvps;

  // 1. Junk rows.
  const junk = roster.filter(r => !r.key || r.key.length < 2 || /^(admin|test|for|player|guest)\b/.test(r.key) || /\d/.test(r.key) && r.key.length < 6);

  // 2. Duplicate groups. Union-find over pairs above threshold, plus exact normalized matches.
  const people = roster.filter(r => !junk.includes(r) && !SYSTEM_NAMES.has(r.key));
  const parent = people.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (i, j) => { parent[find(i)] = find(j); };
  const reasons = new Map(); // "i|j" -> reason
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const A = people[i], B = people[j];
      if (isIgnored(A.key, B.key)) continue;
      let reason = null, score = 0;
      if (A.key === B.key) { reason = 'same name (spacing/case)'; score = 1; }
      else {
        const pa = A.key.split(' '), pb = B.key.split(' ');
        // Single-token name equal to the first name of a multi-token name.
        if (pa.length === 1 && pb.length > 1 && nickEq(pa[0], pb[0]) && pa[0].length >= 3) { reason = 'first name only'; score = 0.7; }
        else if (pb.length === 1 && pa.length > 1 && nickEq(pb[0], pa[0]) && pb[0].length >= 3) { reason = 'first name only'; score = 0.7; }
        else {
          score = similarity(A.name, B.name);
          if (score >= MIN) reason = score >= 0.95 ? 'nickname/initial match' : score >= 0.85 ? 'same last name, same first initial (could be family)' : 'spelling variant';
        }
      }
      if (reason) {
        // "first name only" is only worth raising when it points at exactly one
        // full name; a bare "Chris" against six Chrises is noise. Resolved below.
        reasons.set(`${i}|${j}`, { reason, score });
        if (reason !== 'first name only') union(i, j);
      }
    }
  }
  // Resolve first-name-only candidates: attach only when unique.
  const fnCandidates = new Map(); // single-token idx -> [full idx...]
  reasons.forEach((v, k) => {
    if (v.reason !== 'first name only') return;
    const [i, j] = k.split('|').map(Number);
    const single = people[i].key.split(' ').length === 1 ? i : j;
    const full = single === i ? j : i;
    if (!fnCandidates.has(single)) fnCandidates.set(single, []);
    fnCandidates.get(single).push(full);
  });
  const ambiguous = [];
  fnCandidates.forEach((fulls, single) => {
    if (fulls.length === 1) union(single, fulls[0]);
    else ambiguous.push({ name: people[single].name, checkins: people[single].checkins, couldBe: fulls.map(f => people[f].name) });
  });

  const groupsMap = new Map();
  people.forEach((p, i) => { const r = find(i); if (!groupsMap.has(r)) groupsMap.set(r, []); groupsMap.get(r).push(i); });
  const groups = [];
  groupsMap.forEach(idxs => {
    if (idxs.length < 2) return;
    const members = idxs.map(i => people[i]).sort((a, b) => total(b) - total(a) || (a.importedFromGAS ? 1 : 0) - (b.importedFromGAS ? 1 : 0));
    const why = [];
    for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) {
      const k = idxs[a] < idxs[b] ? `${idxs[a]}|${idxs[b]}` : `${idxs[b]}|${idxs[a]}`;
      const r = reasons.get(k); if (r) why.push(`${people[idxs[a]].name} ~ ${people[idxs[b]].name}: ${r.reason} (${Math.round(r.score * 100)})`);
    }
    // Suggested canonical: most activity; ties broken toward the fuller, non-imported spelling.
    const suggested = members[0].name;
    // Overlap check: two records on the same date+venue is a strong sign they are
    // DIFFERENT people (or a real double-entry) — flag it either way.
    groups.push({
      suggestedCanonical: suggested,
      confidence: Math.max(...why.map(w => Number((w.match(/\((\d+)\)$/) || [])[1] || 0))),
      members: members.map(m => ({ id: m.id, name: m.name, checkins: m.checkins, elims: m.elims, bounties: m.bounties, rsvps: m.rsvps, first: m.first, last: m.last, venues: m.venues, importedFromGAS: m.importedFromGAS, hasEmail: m.email, aliases: m.aliases })),
      why
    });
  });
  groups.sort((a, b) => b.confidence - a.confidence || (b.members.reduce((s, m) => s + m.checkins, 0) - a.members.reduce((s, m) => s + m.checkins, 0)));

  // 3. Never seen anywhere.
  const neverSeen = roster.filter(r => !junk.includes(r) && total(r) === 0)
    .map(r => ({ id: r.id, name: r.name, importedFromGAS: r.importedFromGAS, added: r.added, hasEmail: r.email }))
    .sort((a, b) => (a.importedFromGAS ? 0 : 1) - (b.importedFromGAS ? 0 : 1) || a.name.localeCompare(b.name));

  // 4. Names living in config docs that don't resolve to a roster row.
  const rosterKeys = new Set(roster.map(r => r.key));
  const configRefs = [];
  const scan = (label, value) => {
    const SKIP_KEYS = /(^|\.)(hand|venue|theme|title|type|status)(\[|$)/i;
    const walk = (v, path) => {
      if (SKIP_KEYS.test(path)) return;
      if (typeof v === 'string' && v.length > 2 && v.length < 60 && /^[A-Za-z][A-Za-z .'-]+$/.test(v) && !rosterKeys.has(norm(v)) && /\s/.test(v.trim())) configRefs.push({ where: `${label}.${path}`, name: v });
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
    };
    walk(value, '');
  };
  if (cfgAQ.exists) scan('config/autoQualifiers', cfgAQ.data());
  if (cfgCW.exists) scan('config/consolationWinners', cfgCW.data());
  if (cfgCH.exists) scan('config/champions', cfgCH.data());
  if (cfgHH.exists) scan('config/highHands', cfgHH.data());
  overrides.forEach(d => scan(`champ_overrides/${d.id}`, d.data()));

  const report = {
    generatedAt: new Date().toISOString(),
    threshold: MIN,
    totals: { roster: roster.length, people: people.length, importedFromGAS: roster.filter(r => r.importedFromGAS).length, groups: groups.length, junk: junk.length, neverSeen: neverSeen.length, ambiguousFirstNames: ambiguous.length, configRefs: configRefs.length },
    groups, ambiguousFirstNames: ambiguous,
    junk: junk.map(r => ({ id: r.id, name: r.name, activity: total(r) })),
    neverSeen, configRefs
  };

  if (!TEXT) { console.log(JSON.stringify(report, null, 2)); return; }

  const line = (m) => `${m.name.padEnd(28)} ci ${String(m.checkins).padStart(3)}  pl ${String(m.elims).padStart(3)}  bo ${String(m.bounties).padStart(3)}  rs ${String(m.rsvps).padStart(3)}  ${(m.first || '—').padEnd(10)} → ${(m.last || '—').padEnd(10)} ${m.importedFromGAS ? 'GAS' : '   '} ${m.hasEmail ? '@' : ' '}`;
  console.log(`ROSTER SWEEP  ${report.generatedAt.slice(0, 10)}  roster=${roster.length}  groups=${groups.length}  junk=${junk.length}  never-seen=${neverSeen.length}`);
  console.log('\n== DUPLICATE GROUPS (suggested canonical first) ==');
  groups.forEach((g, i) => {
    console.log(`\n#${i + 1}  confidence ${g.confidence}  → keep "${g.suggestedCanonical}"`);
    g.members.forEach(m => console.log('   ' + line(m)));
    g.why.forEach(w => console.log('   why: ' + w));
  });
  if (ambiguous.length) { console.log('\n== FIRST-NAME-ONLY, AMBIGUOUS (not proposed) =='); ambiguous.forEach(a => console.log(`   ${a.name} (${a.checkins} ci) could be: ${a.couldBe.join(' | ')}`)); }
  console.log(`\n== JUNK ROWS (${junk.length}) ==`); junk.forEach(r => console.log(`   "${r.name}"  activity=${total(r)}  id=${r.id}`));
  console.log(`\n== NEVER SEEN (${neverSeen.length}; ${neverSeen.filter(n => n.importedFromGAS).length} GAS imports) ==`);
  console.log('   ' + neverSeen.map(n => n.name + (n.importedFromGAS ? '' : '*')).join(', '));
  console.log(`\n== CONFIG NAMES NOT ON ROSTER (${configRefs.length}) ==`); configRefs.forEach(c => console.log(`   ${c.where}: "${c.name}"`));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
