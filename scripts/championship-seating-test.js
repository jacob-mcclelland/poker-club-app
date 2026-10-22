// Exercises the championship seating rules in public/champ-seating.js.
// No DOM, no network. Run: node scripts/championship-seating-test.js
const fs = require('fs');
const path = require('path');

// The module is browser ESM; strip the `export` keywords and evaluate it.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'champ-seating.js'), 'utf8')
  .replace(/^export const /mg, 'const ')
  .replace(/^export function /mg, 'function ')
  .replace(/^export async function /mg, 'async function ');
const api = new Function(src + '\n return { buildSeating, buildChampionshipRanking, rankByBounties, markTies, splitOverrides, seatedRoster, seatKey, normalizeSeat, formatSeat, seatChipHtml, SECTIONS, ROSTER_SIZE, CONSOL_SEATS };')();
const { buildSeating, buildChampionshipRanking, rankByBounties, splitOverrides } = api;

// 26 ranked players: 20 seats + 6 alternates.
const ranked = [];
for (let i = 1; i <= 26; i++) ranked.push({ name: 'P' + i, points: 500 - i * 10, bounties: 30 - i });

let fails = 0;
const check = (desc, cond) => { console.log('    ' + (cond ? 'PASS ' : 'FAIL ') + desc); if (!cond) fails++; };
function run(label, { att, overrides = {}, closed = false, times = {}, consolSeats }) {
  const s = buildSeating({ ranked, attendance: att, checkinTime: times, overrides, doorsClosed: closed, scoreField: 'points', consolSeats });
  const names = sec => (s[sec] || []).map(p => p.name).join(',') || '-';
  console.log('\n' + label);
  ['playing', 'cleared', 'ondeck', 'consolation', 'consolWait', 'out'].forEach(sec => console.log('  ' + sec.padEnd(11) + '(' + (s[sec] || []).length + '): ' + names(sec)));
  console.log('  meta: ' + JSON.stringify(s.meta));
  return s;
}

let att = {}; for (let i = 1; i <= 20; i++) att['P' + i] = 'ci';
['P21', 'P22', 'P23', 'P24'].forEach(n => att[n] = 'ci');
let s = run('1. Full house, doors open — no seat is open', { att });
check('nobody cleared', s.cleared.length === 0);
check('no open seats reported', s.meta.openNow === 0);
check('all 4 alternates go straight to consolation', s.consolation.length === 4);
check('on deck is empty', s.ondeck.length === 0);

att = {}; for (let i = 1; i <= 14; i++) att['P' + i] = 'ci';
['P21', 'P22', 'P23', 'P24'].forEach(n => att[n] = 'ci');
s = run('2. Six seats unconfirmed, doors open — seats are HELD', { att });
check('nobody cleared yet', s.cleared.length === 0);
check('0 open now', s.meta.openNow === 0);
check('6 unconfirmed', s.meta.unconfirmed === 6);
check('4 alternates wait on deck', s.ondeck.length === 4);
check('consolation empty', s.consolation.length === 0);

att['P3'] = 'declined';
s = run('3. One player declines — top alternate auto-fills', { att });
check('P21 auto-cleared', s.cleared.length === 1 && s.cleared[0].name === 'P21');
check('P3 STAYS in playing at rank 3, flagged out (red x), and is in out', s.playing[2].name === 'P3' && s.playing[2].out === true && s.out.some(p => p.name === 'P3'));
check('P3 not in consolation', !s.consolation.some(p => p.name === 'P3'));
check('playing still lists all 20 in order', s.playing.length === 20 && s.playing.map(p=>p.name).join(',') === Array.from({length:20},(_,i)=>'P'+(i+1)).join(','));
check('3 alternates still on deck', s.ondeck.length === 3);

s = run('4. Doors closed — no-shows give up seats', { att, closed: true });
check('all present alternates cleared', s.cleared.length === 4);
check('on deck now empty', s.ondeck.length === 0);
check('7 no-shows flagged out but still in playing', s.out.length === 7 && s.playing.filter(p => p.out).length === 7 && s.playing.length === 20);
check('consolation holds nobody who is not here', s.consolation.every(p => p.status === 'ci'));

att = {}; for (let i = 1; i <= 20; i++) att['P' + i] = 'ci';
['P21', 'P22'].forEach(n => att[n] = 'ci');
s = run('5. Manual move to On Deck with ZERO open seats (the revert bug)', { att, overrides: { p22: 'ondeck' } });
check('P22 STAYS on deck', s.ondeck.some(p => p.name === 'P22'));
check('flagged manual', s.ondeck.find(p => p.name === 'P22').manual === true);

s = run('6. Same override rebuilt — must not drift', { att, overrides: { p22: 'ondeck' } });
check('still on deck after rebuild', s.ondeck.some(p => p.name === 'P22'));

s = run('7. Manual promote of an alternate to Cleared', { att, overrides: { p21: 'cleared' } });
check('P21 in cleared, manual', s.cleared.some(p => p.name === 'P21' && p.manual));

s = run('8. Override removed — back to automatic', { att, overrides: {} });
check('P21 back in consolation', s.consolation.some(p => p.name === 'P21'));
check('nothing manual', ['playing', 'cleared', 'ondeck', 'consolation'].every(sec => s[sec].every(p => !p.manual)));

att['P5'] = 'declined';
s = run('9. Override keeps a declined player seated', { att, overrides: { p5: 'playing' } });
check('P5 still playing and NOT flagged out', s.playing.some(p => p.name === 'P5' && !p.out));
check('no seat opened', s.meta.openNow === 0);

att['Brand New Guy'] = 'ci';
s = run('10. Unranked walk-in lands in consolation', { att });
check('walk-in in consolation', s.consolation.some(p => p.name === 'Brand New Guy'));

// Consolation cap + arrival-order waitlist.
att = {}; for (let i = 1; i <= 20; i++) att['P' + i] = 'ci';
const times = {};
for (let i = 21; i <= 26; i++) { att['P' + i] = 'ci'; times['P' + i] = 1000 * i; }          // ranked alternates, later arrivals
const walkins = ['Early Bird', 'Second In', 'Late Larry'];
walkins.forEach((n, i) => { att[n] = 'ci'; times[n] = 10 + i; });                            // walk-ins arrived FIRST
s = run('11. Consolation cap 4 — the WHOLE table is arrival order, points never decide a seat', { att, times, consolSeats: 4 });
check('4 seated', s.consolation.length === 4);
check('seats go to the first four to check in (walk-ins beat higher-ranked later arrivals)', s.consolation.map(p => p.name).join(',') === 'Early Bird,Second In,Late Larry,P21');
check('5 on waitlist', s.consolWait.length === 5);
check('waitlist continues in check-in order', s.consolWait.map(p => p.name).join(',') === 'P22,P23,P24,P25,P26');
check('meta reports waiting', s.meta.consolWaiting === 5 && s.meta.consolFilled === 4);

s = run('12. Director hand-places the latest arrival in consolation — they take their arrival slot, no line-jumping', { att, times, consolSeats: 4, overrides: { p26: 'consolation' } });
check('seated four unchanged', s.consolation.map(p => p.name).join(',') === 'Early Bird,Second In,Late Larry,P21');
check('P26 is flagged manual but still last on the waitlist', s.consolWait[s.consolWait.length - 1].name === 'P26' && s.consolWait[s.consolWait.length - 1].manual);

s = run('13. Missing check-in time sorts to the END of the waitlist', { att, times: { ...times, 'Early Bird': undefined }, consolSeats: 4 });
check('Early Bird last on waitlist', s.consolWait[s.consolWait.length - 1].name === 'Early Bird');

// Ranking + override splitting helpers.
const st = [{ name: 'A', points: 10, qualified: true }, { name: 'B', points: 300 }, { name: 'C', points: 200 }];
const r = buildChampionshipRanking(st);
check('berth holder included in top group', r.slice(0, 3).some(p => p.name === 'A' && p._hasBerth));
const sp = splitOverrides({ 1: { 'jane doe': 'cleared', '__doorsclosed__': 'closed', 'old guy': 'auto' }, 2: {} });
check('splitOverrides: doors closed for game 1', sp.doors[1] === true && sp.doors[2] === false);
check('splitOverrides: auto dropped, reserved key hidden', Object.keys(sp.overrides[1]).join(',') === 'jane doe');

// Bounty tiebreak: bounties, then games played, then RSVPs honored, then name.
const bst = [
  { name: 'Zed', bounties: 12, gamesPlayed: 5, rsvpsHonored: 0, points: 100 },
  { name: 'Amy', bounties: 12, gamesPlayed: 5, rsvpsHonored: 0, points: 300 },
  { name: 'Bob', bounties: 12, gamesPlayed: 7, rsvpsHonored: 0, points: 50 },
  { name: 'Cal', bounties: 13, gamesPlayed: 1, rsvpsHonored: 0, points: 10 }
];
const br = rankByBounties(bst);
check('bounty order: Cal(13), Bob(12,7gp), Amy(12,5gp), Zed(12,5gp)', br.map(p => p.name).join(',') === 'Cal,Bob,Amy,Zed');
check('Amy and Zed tied at T3, Bob not tied', br[2]._rank === 3 && br[2]._tied && br[3]._rank === 3 && br[3]._tied && !br[1]._tied);
check('season points do NOT break a bounty tie', br.findIndex(p => p.name === 'Amy') < br.findIndex(p => p.name === 'Zed'));
const hr = rankByBounties([
  { name: 'Zed', bounties: 12, gamesPlayed: 5, rsvpsHonored: 4 },
  { name: 'Amy', bounties: 12, gamesPlayed: 5, rsvpsHonored: 1 }
]);
check('more honored RSVPs wins the tie (Zed over Amy despite name)', hr[0].name === 'Zed' && !hr[0]._tied && hr[1]._rank === 2);
const hp = buildChampionshipRanking([{ name: 'B', points: 300, gamesPlayed: 4, rsvpsHonored: 2 }, { name: 'A', points: 300, gamesPlayed: 4, rsvpsHonored: 3 }]);
check('points ranking: honored RSVPs before name', hp[0].name === 'A' && hp[0]._rank === 1 && hp[1]._rank === 2);
const pst = buildChampionshipRanking([{ name: 'A', points: 300, gamesPlayed: 4 }, { name: 'B', points: 300, gamesPlayed: 4 }, { name: 'C', points: 290, gamesPlayed: 9 }]);
check('points tie marked on both, C untied at 3', pst[0]._tied && pst[1]._tied && pst[0]._rank === 1 && pst[1]._rank === 1 && pst[2]._rank === 3 && !pst[2]._tied);
const seated = buildSeating({ ranked: pst, attendance: { A: 'ci', B: 'ci', C: 'ci' }, scoreField: 'points' });
check('tie flag and shared display rank reach seating entries', seated.playing[0].tied === true && seated.playing[1].dispRank === 1 && seated.playing[2].tied === false);

// Director taps Seated on a cleared alternate → they move into Playing as a manual row.
att = {}; for (let k = 1; k <= 20; k++) att['P' + k] = 'ci'; att['P3'] = 'declined'; att['P21'] = 'ci'; att['P22'] = 'ci';
s = run('14. Seated: cleared alternate promoted into Playing', { att, overrides: { p21: 'playing' } });
check('P21 in playing, manual', s.playing.some(p => p.name === 'P21' && p.manual));
check('P21 no longer in cleared', !s.cleared.some(p => p.name === 'P21'));
check('P3 still in playing flagged out; seat counts as filled by P21', s.playing.some(p => p.name === 'P3' && p.out) && s.meta.filled === 20);
check('seat is taken by P21, so 0 open now and P22 is not auto-cleared', s.meta.openNow === 0 && !s.cleared.some(p => p.name === 'P22'));

// 15. Promoted alternates never jump above berth holders on the display.
// Ranks 16-20 are low-point auto-qualifiers (berth holders); P21/P22 have MORE
// points than them but are alternates. When P21 is seated, the seated roster
// must keep P21 at the bottom, below every berth holder, and keep rank numbers.
{
  const rk = [];
  for (let i = 1; i <= 15; i++) rk.push({ name: 'P' + i, points: 600 - i * 10, gamesPlayed: 8 });
  for (let i = 16; i <= 20; i++) rk.push({ name: 'Q' + i, points: 100 + (20 - i), gamesPlayed: 5, qualified: true });
  rk.push({ name: 'P21', points: 300, gamesPlayed: 8 });
  rk.push({ name: 'P22', points: 290, gamesPlayed: 8 });
  const a = {}; rk.forEach(p => a[p.name] = 'ci'); a['P3'] = 'declined';
  const st = buildSeating({ ranked: rk, attendance: a, overrides: { p21: 'playing' }, scoreField: 'points' });
  const roster = api.seatedRoster(st).map(p => p.name);
  console.log('\n15. Seated roster order with P21 promoted: ' + roster.join(','));
  check('P21 is LAST in the seated roster', roster[roster.length - 1] === 'P21');
  check('every berth holder Q16..Q20 sits above P21', ['Q16', 'Q17', 'Q18', 'Q19', 'Q20'].every(q => roster.indexOf(q) < roster.indexOf('P21')));
  check('P21 keeps display rank 21 (not renumbered by points)', api.seatedRoster(st).find(p => p.name === 'P21').dispRank === 21);
  check('Q20 keeps display rank 20', api.seatedRoster(st).find(p => p.name === 'Q20').dispRank === 20);
  check('roster has 20 seated rows + 1 out row (P3 stays listed, out)', roster.length === 21 && st.playing.find(p => p.name === 'P3').out === true);
}

// 16. Seat assignments ride in the overrides doc under __seat__ keys and reach every entry.
{
  const raw = { 1: {}, 2: { '__seat__q18': '7', '__seat__p21': 'T2-4', '__seat__p22': 'auto', '__doorsclosed__': 'closed', 'p21': 'playing' } };
  const sp = splitOverrides(raw);
  check('splitOverrides: seats parsed for game 2', sp.seats[2]['q18'] === '7' && sp.seats[2]['p21'] === 'T2-4');
  check('splitOverrides: a cleared seat (auto) is dropped', !('p22' in sp.seats[2]));
  check('splitOverrides: seat keys do not leak into overrides', !('__seat__q18' in sp.overrides[2]) && sp.overrides[2]['p21'] === 'playing');
  check('splitOverrides: doors still parsed', sp.doors[2] === true);
  const rk = [];
  for (let i = 1; i <= 20; i++) rk.push({ name: 'P' + i, points: 600 - i * 10, gamesPlayed: 8 });
  rk[17].name = 'Q18'; rk[17].qualified = true;
  rk.push({ name: 'P21', points: 300, gamesPlayed: 8 });
  const a = {}; rk.forEach(p => a[p.name] = 'ci'); a['Q18'] = 'rsvp'; a['P5'] = 'declined';
  const st = buildSeating({ ranked: rk, attendance: a, overrides: sp.overrides[2], seats: sp.seats[2], doorsClosed: sp.doors[2], scoreField: 'points' });
  check('seat chip stamped on an unarrived berth holder', st.playing.find(p => p.name === 'Q18').seat === '7');
  check('seat chip stamped on a promoted alternate', st.playing.find(p => p.name === 'P21').seat === 'T2-4');
  check('no seat → empty string, never undefined', st.playing.find(p => p.name === 'P1').seat === '');
  check('seatKey lower-cases the name', api.seatKey('Jeff Ginsburg') === '__seat__jeff ginsburg');
}

// 17. Seat format: suit letter + card value, normalized however it was typed.
{
  const n = api.normalizeSeat;
  check('S7 stays S7', n('S7') === 'S7');
  check('lower case, spaces and dashes are normalized (" s - 7 " → S7)', n(' s - 7 ') === 'S7');
  check('HA / hk / h10 accepted', n('HA') === 'HA' && n('hk') === 'HK' && n('h10') === 'H10');
  check('clubs and diamonds accepted too', n('c2') === 'C2' && n('dq') === 'DQ');
  check('card-first input is accepted and stored suit-first (7s → S7, 10h → H10, ah → HA)', n('7s') === 'S7' && n('10h') === 'H10' && n('ah') === 'HA' && n(' 7 - S ') === 'S7');
  check('card-first junk still rejected (1s, 11h, bs)', n('1s') === null && n('11h') === null && n('bs') === null);
  check('bad card values rejected (S1, S11, SB)', n('S1') === null && n('S11') === null && n('SB') === null);
  check('bad suit / missing parts rejected (X7, 7, S, "")', n('X7') === null && n('7') === null && n('S') === null && n('') === null);
  check('formatSeat shows the suit symbol', api.formatSeat('S7') === '♠7' && api.formatSeat('ha') === '♥A');
  check('formatSeat passes legacy free text through', api.formatSeat('T2-4') === 'T2-4');
  check('chip: hearts are red, spades are not', /class="seat-chip red"/.test(api.seatChipHtml('HA')) && /class="seat-chip"/.test(api.seatChipHtml('S7')));
  check('chip: empty seat → no markup', api.seatChipHtml('') === '' && api.seatChipHtml(undefined) === '');
  check('chip: legacy text is escaped', api.seatChipHtml('<b>') === '<span class="seat-chip" title="Seat">&lt;b&gt;</span>');
}

// 18. The two rankings must not share objects: building the bounty list from
// the championship list used to overwrite every player's _rank with their
// bounty rank, so the Championship panel showed bounty ranks (WC 9/10/2026).
{
  const raw = [
    { name: 'Phil', points: 430, bounties: 12, gamesPlayed: 12 },   // #1 points, low bounties
    { name: 'Jamie', points: 275, bounties: 32, gamesPlayed: 12 },  // #1 bounties, mid points
    { name: 'Kyle', points: 425, bounties: 14, gamesPlayed: 9 },
    { name: 'Robb', points: 405, bounties: 23, gamesPlayed: 7 }
  ];
  const league = buildChampionshipRanking(raw);
  const bounty = rankByBounties(league);           // the exact call order every page uses
  const lr = n => league.find(p => p.name === n)._rank;
  const br = n => bounty.find(p => p.name === n)._rank;
  check('championship ranks survive building the bounty list (Phil #1, Jamie #4)', lr('Phil') === 1 && lr('Jamie') === 4);
  check('bounty ranks are bounty-based (Jamie #1, Phil #4)', br('Jamie') === 1 && br('Phil') === 4);
  check('the two lists hold different objects', league.find(p => p.name === 'Phil') !== bounty.find(p => p.name === 'Phil'));
  check('input rows are left untouched', !('_rank' in raw[0]));
  const seat = buildSeating({ ranked: league, attendance: { Phil: 'ci', Jamie: 'ci', Kyle: 'ci', Robb: 'ci' }, scoreField: 'points' });
  check('seating shows the championship rank for Jamie (4), not her bounty rank (1)', seat.playing.find(p => p.name === 'Jamie').dispRank === 4);
}

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'all checks passed'));
process.exit(fails ? 1 : 0);
