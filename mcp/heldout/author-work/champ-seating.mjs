/**
 * Championship-night seating rules — THE single implementation.
 *
 * Used by championship-director.html (editing) and champ-night.html (the
 * read-only dashboard). Pure functions over plain data; no Firebase import,
 * so it can also be required by scripts/championship-seating-test.js.
 *
 * Sections, top to bottom:
 *   playing     the top-20, in rank order. A player who gave up their seat
 *               (declined, or doors closed and never arrived) STAYS in this
 *               list with out:true — shown with a red ✗, never removed or
 *               re-ranked (the owner's rule). Their seat is open and is filled from
 *               On Deck into `cleared`.
 *   cleared     alternates who have been given a seat
 *   ondeck      alternates waiting, as deep as seats that could still open
 *   consolation present players with a consolation seat (capped), in ARRIVAL
 *               order — check-in time, never points (the owner, 2026-09-11)
 *   consolWait  present players past the consolation cap, same arrival order
 *   out         the same out:true players, as a separate list for counts
 *
 * One definition of an open seat, used everywhere: the holder declined, or the
 * doors are closed and they never arrived. While the doors are open a no-show
 * KEEPS their seat.
 */

export const ROSTER_SIZE = 20;
export const CONSOL_SEATS = 20;
export const SECTIONS = ['playing', 'cleared', 'ondeck', 'consolation'];
export const DOORS_KEY = '__doorsclosed__';
// Seat assignments ride in the same champ_overrides doc as the section moves,
// under a reserved player key: g2___seat__<name lower> = "7" (or 'auto' to
// clear). Same trick as DOORS_KEY, so no server change was needed.
export const SEAT_KEY_PREFIX = '__seat__';
export const seatKey = (name) => SEAT_KEY_PREFIX + String(name || '').toLowerCase();

/**
 * Seat format (the owner, 2026-09-09): table = a suit letter (the venue's tables are
 * marked by suit — in practice always S or H), seat = a card value 2-10, J, Q,
 * K or A. Stored canonically as e.g. "S7", "HA", "H10". Seats are optional:
 * the director types one only for a player who is not at the table yet.
 * Typed in EITHER order — 's7' or '7s', 'h10' or '10h', 'ah' or 'ha' — and
 * always stored and shown suit-first, because the suit is what tells the
 * player which table to walk to. normalizeSeat('7 s') → 'S7'; junk → null.
 */
const SEAT_RE = /^([SHCD])(10|[2-9]|[JQKA])$/;
const SEAT_RE_CARD_FIRST = /^(10|[2-9]|[JQKA])([SHCD])$/;
const SUIT_SYMBOL = { S: '♠', H: '♥', C: '♣', D: '♦' };
export function normalizeSeat(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let m = s.match(SEAT_RE);
  if (m) return m[1] + m[2];
  m = s.match(SEAT_RE_CARD_FIRST);
  return m ? m[2] + m[1] : null;
}
/** 'S7' → '♠7'. Unknown/legacy text is returned as typed. */
export function formatSeat(seat) {
  const n = normalizeSeat(seat);
  return n ? SUIT_SYMBOL[n[0]] + n.slice(1) : String(seat || '');
}
/** Gold chip markup shared by the director page, the dashboard and the TV. */
export function seatChipHtml(seat) {
  if (!seat) return '';
  const n = normalizeSeat(seat);
  const red = !!n && (n[0] === 'H' || n[0] === 'D');
  const text = formatSeat(seat).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<span class="seat-chip${red ? ' red' : ''}" title="Seat">${text}</span>`;
}

/**
 * The seated roster in DISPLAY order — what the TV's standings panel shows in
 * championship mode. Playing (the original top-20 in rank order, out players
 * included with out:true) followed by Cleared (alternates given a seat).
 * Never re-sort this by points: a promoted alternate keeps their rank-21+
 * position below every berth holder, per the owner (2026-09-08).
 */
export function seatedRoster(state) {
  return [...(state.playing || []), ...(state.cleared || [])];
}

/**
 * Build the seating state for one game.
 * @param {Object} o
 * @param {Array}  o.ranked        [{ name, points, bounties }] in ranking order
 * @param {Object} o.attendance    { name: 'ci' | 'rsvp' | 'declined' }
 * @param {Object} o.checkinTime   { name: epochMs } (missing → treated as latest)
 * @param {Object} o.overrides     { nameLower: section }
 * @param {Object} [o.seats]       { nameLower: "7" } seat assignments (shown as a chip)
 * @param {boolean} o.doorsClosed
 * @param {'points'|'bounties'} o.scoreField
 * @param {number} [o.rosterSize]
 * @param {number} [o.consolSeats]
 */
export function buildSeating({ ranked, attendance, checkinTime = {}, overrides = {}, seats = {}, doorsClosed = false, scoreField = 'points', rosterSize = ROSTER_SIZE, consolSeats = CONSOL_SEATS }) {
  const att = attendance || {};
  const timeOf = (name) => {
    const t = checkinTime[name];
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const makeEntry = (p, rank) => ({
    name: p.name,
    score: scoreField === 'bounties' ? (p.bounties || 0) : Math.round(p.points || 0),
    origRank: rank,
    status: att[p.name] || '',
    checkinAt: timeOf(p.name),
    qualified: !!p.qualified,   // holds a berth (win, consolation, or auto-qualifier)
    tied: !!p._tied,            // shares its rank with a neighbour (display as T#)
    dispRank: p._rank || rank,   // rank to SHOW (tied rows share it); origRank is list position
    out: false,                  // gave up the seat (declined / no-show after doors closed)
    manual: false
  });

  const isOut = (e) => e.status === 'declined' || (doorsClosed && e.status !== 'ci');

  const top20 = ranked.slice(0, rosterSize).map((p, i) => makeEntry(p, i + 1));
  const held = [];
  const out = [];
  top20.forEach(e => {
    if (isOut(e) && overrides[e.name.toLowerCase()] !== 'playing') { e.out = true; out.push(e); }
    else held.push(e);
  });
  const openSeats = out.length;

  const heldNames = new Set(top20.map(p => p.name));
  const alternates = ranked.slice(rosterSize)
    .map((p, i) => makeEntry(p, rosterSize + i + 1))
    .filter(e => att[e.name] === 'ci' && !heldNames.has(e.name));

  // Automatic: fill open seats from the top of the alternate list.
  const cleared = alternates.slice(0, openSeats);
  // Automatic: the next ones wait, but only as deep as seats that could still open.
  const rest = alternates.slice(openSeats);
  const couldStillOpen = doorsClosed ? 0 : held.filter(p => p.status !== 'ci').length;
  const ondeck = rest.slice(0, couldStillOpen);
  const overflow = rest.slice(couldStillOpen);

  const rankedNames = new Set(ranked.map(p => p.name));
  const unranked = Object.entries(att)
    .filter(([n, st]) => !rankedNames.has(n) && st === 'ci')
    .map(([n]) => ({ name: n, score: null, origRank: null, status: 'ci', checkinAt: timeOf(n), manual: false }));

  // Consolation is for people who are HERE. Players who gave up a seat and are
  // not present go to `out` for reference; they must not consume a consolation
  // seat. If one of them walks in, the director moves them by hand.
  // Playing keeps ALL top-20 rows in rank order; the out ones carry out:true.
  const state = {
    playing: top20.slice(),
    cleared,
    ondeck,
    consolation: [...overflow, ...unranked],
    out
  };

  // Manual overrides last: the director's explicit call wins, no redirects.
  Object.entries(overrides).forEach(([playerLower, target]) => {
    if (!state[target] || target === 'out') return;
    let player = null;
    for (const sec of SECTIONS) {
      const idx = state[sec].findIndex(p => p.name.toLowerCase() === playerLower);
      if (idx !== -1) { player = state[sec].splice(idx, 1)[0]; break; }
    }
    // Moving an out player somewhere else takes them off the out list too.
    if (player) { const oi = state.out.indexOf(player); if (oi !== -1) state.out.splice(oi, 1); }
    if (!player) {
      const r = ranked.find(p => p.name.toLowerCase() === playerLower);
      if (r) player = makeEntry(r, ranked.indexOf(r) + 1);
      else {
        const real = Object.keys(att).find(n => n.toLowerCase() === playerLower);
        if (real) player = { name: real, score: null, origRank: null, status: att[real], checkinAt: timeOf(real), manual: false };
      }
    }
    if (player) { player.manual = true; state[target].push(player); }
  });

  const byRank = (a, b) => (a.origRank || 9999) - (b.origRank || 9999);
  state.playing.sort(byRank);
  state.cleared.sort(byRank);
  state.ondeck.sort(byRank);
  state.out.sort(byRank);

  // Consolation is seated in ARRIVAL order — earliest check-in first, season
  // rank only as a tiebreak, missing check-in time last. Points never decide a
  // consolation seat (the owner, 2026-09-11; an earlier version seated by rank and only
  // used arrival order past the cap). The first `consolSeats` arrivals are
  // seated; everyone after that is the waitlist, same order. A hand placement
  // puts a player AT the consolation table but does not jump the line.
  state.consolation.sort((a, b) => a.checkinAt - b.checkinAt || byRank(a, b));
  const seated = state.consolation.slice(0, consolSeats);
  const wait = state.consolation.slice(consolSeats);
  state.consolation = seated;
  state.consolWait = wait;

  // Seat assignments: the director types a seat for anyone holding a main-game
  // seat (mostly berth holders who have not arrived yet), and every display
  // shows it as a chip. Stamped on every entry so no renderer has to look it up.
  const seatOf = (name) => String((seats || {})[String(name).toLowerCase()] || '').trim();
  ['playing', 'cleared', 'ondeck', 'consolation', 'consolWait', 'out'].forEach(sec => {
    (state[sec] || []).forEach(e => { e.seat = seatOf(e.name); });
  });

  state.meta = {
    seats: rosterSize,
    filled: state.playing.filter(p => !p.out).length + state.cleared.length,
    // Seats taken by alternates: those cleared, plus those the director has
    // already marked Seated (moved up into Playing from rank 21+).
    openNow: Math.max(0, state.out.length - state.cleared.length - state.playing.filter(p => (p.origRank || 0) > rosterSize).length),
    unconfirmed: state.playing.filter(p => !p.out && p.status !== 'ci').length,
    closed: !!doorsClosed,
    consolSeats,
    consolFilled: seated.length,
    consolWaiting: wait.length,
    counts: {
      ci: Object.values(att).filter(s => s === 'ci').length,
      rsvp: Object.values(att).filter(s => s === 'rsvp').length,
      declined: Object.values(att).filter(s => s === 'declined').length
    }
  };
  return state;
}

/**
 * Mark ties in a list already sorted by `keys` (e.g. ['points','gamesPlayed']).
 * Two rows tie when every key matches. Sets p._rank and p._tied in place.
 */
export function markTies(list, keys) {
  list.forEach((p, i) => {
    if (i === 0) { p._rank = 1; }
    else {
      const prev = list[i - 1];
      p._rank = keys.every(k => (p[k] || 0) === (prev[k] || 0)) ? prev._rank : i + 1;
    }
  });
  list.forEach(p => { p._tied = list.filter(o => o._rank === p._rank).length > 1; });
  return list;
}

/**
 * Bounty-game ranking. THE rule, shared by the director page, the dashboard
 * and the venue display, and identical to the player app and leaderboard.html:
 *   bounties desc, then games played desc, then RSVPs honored desc, then name.
 * Ties = same bounties, games played AND RSVPs honored.
 */
export function rankByBounties(standings) {
  // COPY the rows before marking ties. markTies writes _rank/_tied onto the
  // objects, and every page builds this list from the championship list —
  // sharing objects meant the bounty ranks overwrote the championship ranks,
  // so the TV's Championship panel showed "T12 Phil Lankford 430" (his bounty
  // rank) on Wild Corgi championship night 2026-09-10.
  const list = standings.map(p => ({ ...p })).sort((a, b) =>
    (b.bounties || 0) - (a.bounties || 0) ||
    (b.gamesPlayed || 0) - (a.gamesPlayed || 0) ||
    (b.rsvpsHonored || 0) - (a.rsvpsHonored || 0) ||
    String(a.name).localeCompare(String(b.name)));
  return markTies(list, ['bounties', 'gamesPlayed', 'rsvpsHonored']);
}

/**
 * Championship ranking = qualified players first (berth holders), then the
 * best non-qualified up to 20, then everyone else — same as the leaderboard
 * page and the venue display.
 */
export function buildChampionshipRanking(standings) {
  // Tiebreakers, in order: games played, then RSVPs honored (RSVP'd and actually
  // played), then name. Same rule as the server's getLeaderboard.
  const byPts = (a, b) => (b.points || 0) - (a.points || 0) || (b.gamesPlayed || 0) - (a.gamesPlayed || 0) || (b.rsvpsHonored || 0) - (a.rsvpsHonored || 0) || String(a.name).localeCompare(String(b.name));
  // Copy the rows so this list's _rank/_tied never collide with rankByBounties'
  // (see the note there).
  const rows = standings.map(p => ({ ...p }));
  const qualified = rows.filter(p => p.qualified).sort(byPts);
  const nonQual = rows.filter(p => !p.qualified).sort(byPts);
  const slots = Math.max(0, ROSTER_SIZE - qualified.length);
  const topNon = nonQual.slice(0, slots);
  const restNon = nonQual.slice(slots);
  const top20 = [...qualified, ...topNon].sort(byPts);
  top20.forEach(p => { p._hasBerth = true; });
  return markTies([...top20, ...restNon], ['points', 'gamesPlayed', 'rsvpsHonored']);
}

/**
 * Attendance for both games on one night, straight from Firestore REST (these
 * collections are public-read). Returns
 *   { attendance: {1:{name:status},2:{...}}, checkinTime: {1:{name:ms},2:{...}} }
 */
export async function loadAttendance({ project, apiKey, venue, date }) {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery?key=${apiKey}`;
  const q = (collection, status, gameNum) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }], where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: date } } },
      { fieldFilter: { field: { fieldPath: 'venue' }, op: 'EQUAL', value: { stringValue: venue } } },
      { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: status } } },
      { fieldFilter: { field: { fieldPath: 'gameNum' }, op: 'EQUAL', value: { integerValue: String(gameNum) } } }
    ] } } } })
  }).then(r => r.json());

  const [ci1, ra1, rd1, ci2, ra2, rd2] = await Promise.all([
    q('checkins', 'active', 1), q('rsvps', 'active', 1), q('rsvps', 'declined', 1),
    q('checkins', 'active', 2), q('rsvps', 'active', 2), q('rsvps', 'declined', 2)
  ]);

  const rows = (res) => (res || []).map(r => r.document && r.document.fields).filter(Boolean)
    .map(f => ({ name: (f.player && f.player.stringValue) || (f.name && f.name.stringValue) || '', at: f.createdAt && f.createdAt.timestampValue ? Date.parse(f.createdAt.timestampValue) : NaN }))
    .filter(r => r.name);

  const build = (ci, ra, rd) => {
    const att = {}, time = {};
    rows(ci).forEach(r => { att[r.name] = 'ci'; if (Number.isFinite(r.at) && !(r.name in time && time[r.name] <= r.at)) time[r.name] = r.at; });
    rows(ra).forEach(r => { if (!att[r.name]) att[r.name] = 'rsvp'; });
    rows(rd).forEach(r => { if (!att[r.name]) att[r.name] = 'declined'; });
    return { att, time };
  };
  const g1 = build(ci1, ra1, rd1), g2 = build(ci2, ra2, rd2);
  return { attendance: { 1: g1.att, 2: g2.att }, checkinTime: { 1: g1.time, 2: g2.time } };
}

/**
 * Split a raw getChampOverrides result into per-game overrides, doors flags and
 * seat assignments. Seats live under SEAT_KEY_PREFIX keys; 'auto' / '' means
 * the seat was cleared.
 */
export function splitOverrides(raw) {
  const overrides = { 1: {}, 2: {} };
  const doors = { 1: false, 2: false };
  const seats = { 1: {}, 2: {} };
  [1, 2].forEach(g => {
    Object.entries((raw && raw[g]) || {}).forEach(([key, val]) => {
      if (key === DOORS_KEY) { doors[g] = val === 'closed'; return; }
      if (key.startsWith(SEAT_KEY_PREFIX)) {
        const name = key.slice(SEAT_KEY_PREFIX.length);
        const v = String(val || '').trim();
        if (name && v && v !== 'auto') seats[g][name] = v;
        return;
      }
      if (key.startsWith('__')) return;
      if (val === 'auto') return;
      overrides[g][key] = val;
    });
  });
  return { overrides, doors, seats };
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
