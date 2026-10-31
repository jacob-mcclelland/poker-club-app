#!/usr/bin/env node
'use strict';
// Writes eval/questions.jsonl: 30 questions with expected answers from the
// independent oracle (eval/oracle.js). Parameters (which player, which night)
// are picked by fixed rules, so the file is reproducible from the fixtures.
// Prints only ids, types and question text, never the expected answers, so
// whoever answers the questions does not see the key.

const fs = require('fs');
const path = require('path');
const { D, BONUS, standings, nights, gameRows, blindLevels, ts, lower } = require('./oracle');

const TE = 'Tight End', WC = 'Wild Corgi';
const Q = [];
const add = (type, question, answer_format, expected, note) => Q.push({ id: `q${String(Q.length + 1).padStart(2, '0')}`, type, question, answer_format, expected, ...(note ? { note } : {}) });
const NUM = { type: 'number' }, NAME = { type: 'name' }, NAMES = { type: 'names', ordered: false }, DATE = { type: 'date' }, TEXT = { type: 'text' };
const ERR = { type: 'error', codes: ['unknown_player', 'unknown_season', 'unknown_venue', 'ambiguous_player', 'no_game', 'game_not_played'] };

const teFall = standings(TE, 'Fall 2026'), wcFall = standings(WC, 'Fall 2026');
const teSum = standings(TE, 'Summer 2026'), wcSum = standings(WC, 'Summer 2026');
const roster = new Set(D.players.map(p => lower(p.name.replace(/\s+/g, ' ').trim())));
const playedNames = new Set(D.checkins.map(c => lower(c.player)));
const unique = (rows, f) => rows.filter(r => f(r) === f(rows[0])).length === 1;
const maxBy = (rows, f) => { const m = Math.max(...rows.map(f)); return rows.filter(r => f(r) === m); };

// ── standings (4) ──────────────────────────────────────────────────────────
add('standings', 'Who is in first place in the Fall 2026 standings at Tight End?', NAME, teFall[0].name);
add('standings', 'How many season points does the Fall 2026 points leader at Wild Corgi have?', NUM, wcFall[0].points);
add('standings', 'Who collected the most bounties in the Summer 2026 season at Tight End? If several players share the most, name all of them.', NAMES, maxBy(teSum, r => r.bounties).map(r => r.name));
add('standings', 'How many players in the Fall 2026 Wild Corgi standings have at least one win?', NUM, wcFall.filter(r => r.wins > 0).length);

// ── player history (5) ─────────────────────────────────────────────────────
const mid = (rows, from) => rows.slice(from).find(r => r.gamesPlayed >= 6 && !r.name.includes('  '));
const p1 = mid(teFall, 14);
add('player_history', `How many games did ${p1.name} play in the Fall 2026 season at Tight End?`, NUM, p1.gamesPlayed);
const p2 = wcSum.find((r, i) => i >= 6 && r.wins === 0 && r.gamesPlayed >= 5);
const finishes = (venue, name, rows) => D.eliminations.filter(e => e.venue === venue && lower(e.player) === lower(name) && rows.some(x => x.name === name && x.gameKeys.has(`${e.date}#${e.gameNum}`))).map(e => e.rank);
add('player_history', `What was ${p2.name}'s best finish (final-table place) in the Summer 2026 season at Wild Corgi?`, NUM, Math.min(...finishes(WC, p2.name, wcSum)));
const p3 = teFall.find((r, i) => i >= 20 && r.bounties >= 5);
add('player_history', `How many bounties did ${p3.name} collect in the Fall 2026 season at Tight End?`, NUM, p3.bounties);
const p4 = wcFall.find(r => r.wins === 1);
const p4win = D.eliminations.find(e => e.venue === WC && e.rank === 1 && lower(e.player) === lower(p4.name) && p4.gameKeys.has(`${e.date}#${e.gameNum}`));
add('player_history', `On what date did ${p4.name} win a game during the Fall 2026 season at Wild Corgi?`, DATE, p4win.date);
const aliased = D.players.find(p => p.aliases && p.aliases.length);
const aliasRow = wcFall.find(r => lower(r.name) === lower(aliased.name));
add('player_history', `How many season points does "${aliased.aliases[0]}" have in the Fall 2026 season at Wild Corgi?`, NUM, aliasRow ? aliasRow.points : 0, 'The name is a roster alias.');

// ── seating (4) ────────────────────────────────────────────────────────────
const teFallNights = nights(TE, 'Fall 2026'), wcFallNights = nights(WC, 'Fall 2026');
const d11 = teFallNights[2];
add('seating', `How many players checked in for game 1 at Tight End on ${d11}?`, NUM, new Set(gameRows('checkins', TE, d11, 1).map(c => lower(c.player))).size);
// Check-in stamps repeat every 25 arrivals, so pick a night whose first arrival is unique.
const firstIn = (venue, d) => {
  const rows = gameRows('checkins', venue, d, 2).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rows.length > 1 && rows[0].createdAt !== rows[1].createdAt ? rows[0] : null;
};
const [v12, d12] = [...wcFallNights.map(d => [WC, d]), ...teFallNights.map(d => [TE, d])].find(([v, d]) => firstIn(v, d));
add('seating', `Who was the first player to check in for game 2 at ${v12} on ${d12}?`, NAME, firstIn(v12, d12).player);
const teChamp = D.seasons.find(s => s.venue === TE && s.name === 'Summer 2026').championshipDate;
const ov = D.champ_overrides.find(o => o.venue === TE && o.date === teChamp);
const movedKey = Object.keys(ov).find(k => /^g1_/.test(k) && ov[k] === 'consolation').slice(3);
const movedName = D.checkins.find(c => lower(c.player) === movedKey).player;
add('seating', `On the Summer 2026 championship night at Tight End, which player did the director move to the consolation table in game 1?`, NAME, movedName);
// Game 1 of a championship seats the top 20 by season bounties (tiebreak games played, RSVPs honored, name).
const wcChamp = D.seasons.find(s => s.venue === WC && s.name === 'Summer 2026').championshipDate;
const byBounty = wcSum.slice().sort((a, b) => b.bounties - a.bounties || b.gamesPlayed - a.gamesPlayed || b.rsvpsHonored - a.rsvpsHonored || a.name.localeCompare(b.name));
const wcOv = D.champ_overrides.find(o => o.venue === WC && o.date === wcChamp);
const movedOut = new Set(Object.keys(wcOv).filter(k => /^g1_/.test(k) && wcOv[k] !== 'playing').map(k => k.slice(3)));
const here = new Set(gameRows('checkins', WC, wcChamp, 1).filter(c => c.status === 'active').map(c => lower(c.player)));
const declined = new Set(gameRows('rsvps', WC, wcChamp, 1).filter(r => r.status === 'declined').map(r => lower(r.player)));
const seated = byBounty.slice(0, 20).filter(r => !movedOut.has(lower(r.name)) && !declined.has(lower(r.name)));
add('seating', `In game 1 of the championship night at Wild Corgi on ${wcChamp}, how many players holding a main-table seat had not checked in yet?`, NUM, seated.filter(r => !here.has(lower(r.name))).length);

// ── structure and rules (4) ────────────────────────────────────────────────
const levels = blindLevels();
const r6 = levels.find(l => l.name === 'Round 6');
add('structure', 'What are the blinds (small/big) in Round 6 of the standard league blind structure? Answer as small/big, for example 25/50.', TEXT, `${r6.small}/${r6.big}`);
const r5i = levels.findIndex(l => l.name === 'Round 5');
add('structure', 'How many minutes after the clock starts (counting the pre-game levels) does Round 5 begin?', NUM, levels.slice(0, r5i).reduce((a, l) => a + l.minutes, 0));
add('structure', 'How many season points does a player who finishes 3rd outright (no tie) earn for that game, including attendance?', NUM, BONUS[3] + 10);
const sched = D.schedule.find(s => s.venue === TE && s.date === '11/17/2026');
add('structure', 'What type of event is scheduled at Tight End on 11/17/2026?', TEXT, sched.type);

// ── ties (4) ───────────────────────────────────────────────────────────────
const tiedGame = D.eliminations.filter(e => e.venue === TE && e.numTied === 2 && e.status === 'processed').sort((a, b) => ts(a.date) - ts(b.date) || a.gameNum - b.gameNum || a.rank - b.rank)[0];
const pair = D.eliminations.filter(e => e.venue === TE && e.date === tiedGame.date && e.gameNum === tiedGame.gameNum && e.rank === tiedGame.rank);
const ord = (n) => n + (['th', 'st', 'nd', 'rd'][n] || 'th');
add('ties', `In game ${tiedGame.gameNum} at Tight End on ${tiedGame.date}, two players tied for ${ord(tiedGame.rank)} place. Who were they, and how many season points did each earn from that game (including attendance)?`,
  { type: 'object', fields: { players: NAMES, points: NUM } }, { players: pair.map(e => e.player), points: tiedGame.bonusPoints + 10 });
let tieQ = null;
for (const [venue, name, rows] of [[WC, 'Fall 2026', wcFall], [TE, 'Fall 2026', teFall], [WC, 'Summer 2026', wcSum], [TE, 'Summer 2026', teSum]]) {
  const r = rows.find((x, i) => i < 40 && rows.filter(y => y.rank === x.rank).length > 1);
  if (r) { tieQ = { venue, name, rank: r.rank, names: rows.filter(y => y.rank === r.rank).map(y => y.name) }; break; }
}
add('ties', `Which players share rank ${tieQ.rank} in the ${tieQ.name} standings at ${tieQ.venue}?`, NAMES, tieQ.names);
let tb = null;
for (const [venue, name, rows] of [[TE, 'Fall 2026', teFall], [WC, 'Fall 2026', wcFall]]) {
  for (let i = 0; i < 30 && !tb; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.points === b.points && a.rank !== b.rank) tb = { venue, name, a, b };
  }
  if (tb) break;
}
const [x, y] = [tb.a, tb.b].sort((m, n) => m.name.localeCompare(n.name));
add('ties', `${x.name} and ${y.name} have the same number of season points in the ${tb.name} standings at ${tb.venue}. Which of them is ranked higher?`, NAME, tb.a.name);
add('ties', 'If three players tie for 4th place at a final table, how many bonus points does each of them receive, not counting attendance?', NUM, Math.ceil((BONUS[4] + BONUS[5] + BONUS[6]) / 3 / 5) * 5);

// ── unknown names, seasons and venues (5) ──────────────────────────────────
const ghost = 'Morgan Quillsby';
if (roster.has(lower(ghost)) || playedNames.has(lower(ghost))) throw new Error('ghost name exists');
add('unknown_names', `How many season points does ${ghost} have in the Fall 2026 season at Tight End?`, ERR, { error: 'unknown_player' });
const typoOf = teFall[3].name;
const typo = typoOf.slice(0, -2) + typoOf.slice(-1) + 'e';
if (roster.has(lower(typo)) || playedNames.has(lower(typo))) throw new Error('typo name exists');
add('unknown_names', `What was ${typo}'s best finish in the Fall 2026 season at Tight End?`, ERR, { error: 'unknown_player' }, 'Misspelling of a real player; the agent must not substitute the suggestion.');
add('unknown_names', 'Who finished first in the Spring 2025 standings at Wild Corgi?', ERR, { error: 'unknown_season' });
add('unknown_names', 'Who leads the current season standings at the Lucky Duck?', ERR, { error: 'unknown_venue' });
const never = D.players.find(p => p.addedVia === 'import' && !playedNames.has(lower(p.name)));
add('unknown_names', `How many games has ${never.name} played in the Fall 2026 season at Wild Corgi?`, NUM, 0, 'On the roster, never played.');

// ── multi-step (4) ─────────────────────────────────────────────────────────
const d27 = teFallNights[5];
const w27 = gameRows('eliminations', TE, d27, 1).find(e => e.rank === 1);
add('multi_step', `Who won game 1 at Tight End on ${d27}, and what is that player's rank in the Fall 2026 Tight End standings?`,
  { type: 'object', fields: { name: NAME, rank: NUM } }, { name: w27.player, rank: teFall.find(r => lower(r.name) === lower(w27.player)).rank });
const lead = wcFall[0];
const d28 = wcFallNights.slice().reverse().find(d => D.bounties.some(b => b.venue === WC && b.date === d && lower(b.player) === lower(lead.name)));
add('multi_step', `How many bounties did the Fall 2026 points leader at Wild Corgi collect on ${d28}, both games combined?`, NUM,
  D.bounties.filter(b => b.venue === WC && b.date === d28 && lower(b.player) === lower(lead.name)).reduce((a, b) => a + b.count, 0));
const d29 = wcFallNights.slice(4).find(d => {
  const ft = gameRows('eliminations', WC, d, 2).map(e => wcFall.find(r => lower(r.name) === lower(e.player)));
  return unique(ft.slice().sort((a, b) => b.points - a.points), r => r.points);
});
const ft29 = gameRows('eliminations', WC, d29, 2).map(e => wcFall.find(r => lower(r.name) === lower(e.player))).sort((a, b) => b.points - a.points);
add('multi_step', `Of the players who made the final table in game 2 at Wild Corgi on ${d29}, who has the most Fall 2026 season points at Wild Corgi?`, NAME, ft29[0].name);
add('multi_step', 'What is the difference in season points between the Fall 2026 leaders at Tight End and at Wild Corgi?', NUM, Math.abs(teFall[0].points - wcFall[0].points));

if (Q.length !== 30) throw new Error(`expected 30 questions, built ${Q.length}`);
fs.writeFileSync(path.join(__dirname, 'questions.jsonl'), Q.map(q => JSON.stringify(q)).join('\n') + '\n');
const byType = Q.reduce((m, q) => ({ ...m, [q.type]: (m[q.type] || 0) + 1 }), {});
console.log(`wrote ${Q.length} questions: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (process.argv.includes('--show')) for (const q of Q) console.log(`${q.id} [${q.type}] ${q.question}  (format: ${JSON.stringify(q.answer_format)})`);
