'use strict';
// Independent answer key. Reads demo/fixtures directly and shares NO code with
// mcp/lib, so a bug in the server cannot quietly make its own answers "right".
// It implements only the slices of the rules the 30 questions need, written
// straight from the rules in CLAUDE.md and functions/index.js.

const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', 'demo', 'fixtures');
const load = (c) => Object.entries(JSON.parse(fs.readFileSync(path.join(DIR, `${c}.json`), 'utf8'))).map(([id, d]) => ({ id, ...d }));
const D = {};
for (const c of ['players', 'seasons', 'schedule', 'checkins', 'eliminations', 'bounties', 'rsvps', 'champ_overrides']) D[c] = load(c);

const BONUS = [0, 90, 85, 80, 70, 60, 50, 40, 30, 20, 10];
const ts = (s) => { const [m, d, y] = s.split('/').map(Number); return Date.UTC(y, m - 1, d); };
const lower = (s) => s.toLowerCase();

function season(venue, name) { return D.seasons.find(s => s.venue === venue && s.name === name); }
function inSeason(s, date) { return ts(date) >= ts(s.startDate) && ts(date) <= ts(s.endDate); }

/** Standings rows for one venue season, sorted and ranked. */
function standings(venue, name) {
  const s = season(venue, name);
  const P = {};
  const get = (n) => (P[lower(n)] = P[lower(n)] || { name: n, points: 0, games: new Set(), wins: 0, bounties: 0, honored: 0 });
  const placedGames = new Set();
  for (const e of D.eliminations) {
    if (e.venue !== venue || !inSeason(s, e.date) || (e.gameType || 'Regular') !== 'Regular') continue;
    const p = get(e.player);
    p.points += (e.bonusPoints === null || e.bonusPoints === undefined ? BONUS[e.rank] : e.bonusPoints) + 10;
    p.games.add(`${e.date}#${e.gameNum}`);
    placedGames.add(`${lower(e.player)}|${e.date}#${e.gameNum}`);
    if (e.rank === 1) p.wins++;
  }
  for (const c of D.checkins) {
    if (c.venue !== venue || c.attendanceOnly !== true || !inSeason(s, c.date)) continue;
    const g = `${c.date}#${c.gameNum}`;
    if (placedGames.has(`${lower(c.player)}|${g}`)) continue;
    const p = get(c.player);
    if (p.games.has(g)) continue;
    p.points += 10; p.games.add(g);
  }
  for (const b of D.bounties) if (b.venue === venue && inSeason(s, b.date)) get(b.player).bounties += b.count;
  for (const r of D.rsvps) {
    if (r.venue !== venue || r.status !== 'converted' || !inSeason(s, r.date)) continue;
    const p = P[lower(r.player)];
    if (p && p.games.has(`${r.date}#${r.gameNum}`)) p.honored++;
  }
  const rows = Object.values(P).map(p => ({ name: p.name, points: p.points, gamesPlayed: p.games.size, wins: p.wins, bounties: p.bounties, rsvpsHonored: p.honored, gameKeys: p.games }));
  rows.sort((a, b) => b.points - a.points || b.gamesPlayed - a.gamesPlayed || b.rsvpsHonored - a.rsvpsHonored || a.name.localeCompare(b.name));
  rows.forEach((r, i) => {
    const p = rows[i - 1];
    r.rank = p && p.points === r.points && p.gamesPlayed === r.gamesPlayed && p.rsvpsHonored === r.rsvpsHonored ? p.rank : i + 1;
  });
  return rows;
}

function nights(venue, seasonName) {
  const s = season(venue, seasonName);
  return [...new Set(D.checkins.filter(c => c.venue === venue && inSeason(s, c.date) && c.gameType === 'Regular').map(c => c.date))].sort((a, b) => ts(a) - ts(b));
}
const gameRows = (coll, venue, date, gameNum) => D[coll].filter(r => r.venue === venue && r.date === date && (gameNum === undefined || r.gameNum === gameNum));

// Blind levels, parsed from the structure file's text (not imported).
function blindLevels() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'clock-structures.js'), 'utf8');
  return [...src.matchAll(/\{ level: ([^,]+), name: "([^"]+)",\s*duration: (\d+), small: (\d+), big: (\d+)/g)]
    .map(m => ({ level: m[1].replace(/'/g, ''), name: m[2], minutes: Number(m[3]), small: Number(m[4]), big: Number(m[5]) }));
}

module.exports = { D, BONUS, standings, season, nights, gameRows, blindLevels, ts, lower };
