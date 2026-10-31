'use strict';
// Season standings, following computeLeaderboard in functions/index.js:
//   - eliminations score bonusPoints + 10 (director format), totalPoints
//     (GAS format) or the old-import rank rule; removed rows and non-Regular
//     game types never score, nor do Championship / Big Stack dates;
//   - attendance-only check-ins score 10, once per game, and never on a game
//     the player already placed in;
//   - bounties are deduplicated per player, date and game;
//   - RSVPs honored = converted RSVPs on games the player is credited with;
//   - order: points, games played, RSVPs honored (all desc), then name;
//     a tie is equal on all three.
// The server keys players by display name; this keys by the normalized name
// so case and spacing variants of one person cannot split a row.

const { inWindow, dateKey, nonSeasonDates, isRegular, seasonSummary } = require('./data');
const { norm } = require('./names');

const BONUS_POINTS = { 1: 90, 2: 85, 3: 80, 4: 70, 5: 60, 6: 50, 7: 40, 8: 30, 9: 20, 10: 10 };
const ATTENDANCE_POINTS = 10;

function tiePoints(rank, numTied) {
  if (rank > 10) return 0;
  let total = 0;
  for (let r = rank; r < rank + numTied && r <= 10; r++) total += BONUS_POINTS[r] || 0;
  return Math.ceil(total / numTied / 5) * 5;
}

const gameKey = (r) => `${dateKey(r.date)}#${r.gameNum}`;

/** Score one venue season. Returns { season, standings, perPlayer }. */
function scoreSeason(data, season) {
  const venue = season.venue;
  const skipDates = nonSeasonDates(data, venue);
  const eligibleDate = (d) => inWindow(d, season.startDate, season.endDate) && !skipDates.has(dateKey(d));
  const seasonMatch = (r) => r.season === undefined || r.season === null || Number(r.season) === Number(season.seasonNumber);

  const stats = {}; // key -> { name, points, bounties, games:Set, wins, events: [] }
  const row = (r) => {
    const k = r.playerLower ? norm(r.playerLower) : norm(r.player);
    if (!stats[k]) stats[k] = { name: r.player.trim().replace(/\s+/g, ' '), key: k, points: 0, bounties: 0, games: new Set(), wins: 0, events: [] };
    return stats[k];
  };

  const placed = {}; // key -> Set(gameKey)
  for (const e of data.eliminations) {
    if (e.venue !== venue || !e.player || e.status === 'removed') continue;
    if (!isRegular(e.gameType) || !eligibleDate(e.date) || !seasonMatch(e)) continue;
    const s = row(e);
    const gk = gameKey(e);
    (placed[s.key] = placed[s.key] || new Set()).add(gk);
    let pts = 0, win = false, format;
    if (e.totalPoints !== undefined && e.totalPoints !== null) { pts = e.totalPoints; win = e.rank === 1; format = 'gas'; }
    else if (e.bonusPoints !== undefined && e.bonusPoints !== null) { pts = e.bonusPoints + ATTENDANCE_POINTS; win = e.rank === 1 || e.bonusPoints === 90; format = 'director'; }
    else if (e.rank !== undefined && e.rank !== null) {
      if (e.rank > 10) { pts = e.rank; win = e.rank >= 100; format = 'import-total'; }
      else { pts = (BONUS_POINTS[e.rank] || 0) + ATTENDANCE_POINTS; win = e.rank === 1; format = 'rank-only'; }
    }
    s.points += pts;
    s.games.add(gk);
    if (win) s.wins++;
    s.events.push({ kind: 'placement', gameKey: gk, date: dateKey(e.date), gameNum: e.gameNum, rank: e.rank, numTied: e.numTied || null, points: pts, finalized: e.status === 'processed', format });
  }

  const seenBounty = new Set();
  for (const b of data.bounties) {
    if (b.venue !== venue || !b.player || b.status === 'removed') continue;
    const bk = `${norm(b.player)}|${b.date}|${b.gameNum}`;
    if (seenBounty.has(bk)) continue;
    seenBounty.add(bk);
    if (!eligibleDate(b.date) || !seasonMatch(b)) continue;
    const s = row(b);
    s.bounties += b.count || 0;
    s.events.push({ kind: 'bounty', gameKey: gameKey(b), date: dateKey(b.date), gameNum: b.gameNum, count: b.count || 0 });
  }

  for (const c of data.checkins) {
    if (c.venue !== venue || !c.player || c.attendanceOnly !== true || c.status === 'removed') continue;
    if (!isRegular(c.gameType) || !inWindow(c.date, season.startDate, season.endDate) || !seasonMatch(c)) continue;
    const k = c.playerLower ? norm(c.playerLower) : norm(c.player);
    const gk = gameKey(c);
    if (placed[k] && placed[k].has(gk)) continue;
    const s = row(c);
    if (s.games.has(gk)) continue; // one attendance credit per game
    s.points += ATTENDANCE_POINTS;
    s.games.add(gk);
    s.events.push({ kind: 'attendance', gameKey: gk, date: dateKey(c.date), gameNum: c.gameNum, points: ATTENDANCE_POINTS, manual: !!c.manuallyAdded });
  }

  const honored = {};
  for (const r of data.rsvps) {
    if (r.venue !== venue || r.status !== 'converted' || !r.player || !r.date) continue;
    if (skipDates.has(dateKey(r.date)) || !inWindow(r.date, season.startDate, season.endDate)) continue;
    const k = r.playerLower ? norm(r.playerLower) : norm(r.player);
    const gk = gameKey(r);
    if (!stats[k] || !stats[k].games.has(gk)) continue;
    (honored[k] = honored[k] || new Set()).add(gk);
  }

  const standings = Object.values(stats).map(s => ({
    name: s.name, points: s.points, gamesPlayed: s.games.size, wins: s.wins, bounties: s.bounties,
    rsvpsHonored: honored[s.key] ? honored[s.key].size : 0, qualified: s.wins > 0
  })).sort(byStanding);
  standings.forEach((s, i) => {
    const p = standings[i - 1];
    s.rank = i > 0 && p.points === s.points && p.gamesPlayed === s.gamesPlayed && p.rsvpsHonored === s.rsvpsHonored ? p.rank : i + 1;
  });
  standings.forEach(s => { s.tied = standings.filter(o => o.rank === s.rank).length > 1; });

  const gamesScored = new Set(Object.values(stats).flatMap(s => [...s.games]));
  const unfinalized = new Set();
  for (const s of Object.values(stats)) for (const ev of s.events) if (ev.kind === 'placement' && !ev.finalized) unfinalized.add(ev.gameKey);

  return {
    season: seasonSummary(season),
    gamesCounted: gamesScored.size,
    unfinalizedGames: [...unfinalized].sort().map(k => { const [date, g] = k.split('#'); return { date, gameNum: Number(g) }; }),
    standings,
    perPlayer: stats
  };
}

function byStanding(a, b) {
  return b.points - a.points || b.gamesPlayed - a.gamesPlayed || b.rsvpsHonored - a.rsvpsHonored || a.name.localeCompare(b.name);
}

module.exports = { scoreSeason, tiePoints, BONUS_POINTS, ATTENDANCE_POINTS };
