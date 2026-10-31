'use strict';
// Unit tests for the four tools, run straight on the functions.
//   cd mcp && npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadData } = require('../lib/data');
const { createTools } = require('../lib/tools');
const { tiePoints } = require('../lib/standings');
const oracle = require('../eval/oracle');

process.env.POKER_AS_OF = '10/20/2026';
const data = loadData();
const t = createTools(data);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

test('standings: ranks follow points, games played, RSVPs honored, name', () => {
  for (const venue of ['Tight End', 'Wild Corgi']) for (const season of ['Summer 2026', 'Fall 2026']) {
    const { standings } = t.getSeasonStandings({ venue, season });
    for (let i = 1; i < standings.length; i++) {
      const a = standings[i - 1], b = standings[i];
      const key = (x) => [x.points, x.gamesPlayed, x.rsvpsHonored];
      assert.ok(a.points > b.points || (a.points === b.points && (a.gamesPlayed > b.gamesPlayed || (a.gamesPlayed === b.gamesPlayed && a.rsvpsHonored >= b.rsvpsHonored))), `${venue} ${season} order at ${i}`);
      if (key(a).join() === key(b).join()) { assert.equal(b.rank, a.rank); assert.ok(a.tied && b.tied); }
      else assert.equal(b.rank, i + 1);
    }
  }
});

test('standings agree with the independent oracle for every season', () => {
  for (const venue of ['Tight End', 'Wild Corgi']) for (const season of ['Summer 2026', 'Fall 2026']) {
    const mine = t.getSeasonStandings({ venue, season }).standings.map(r => `${r.rank}|${r.name}|${r.points}|${r.gamesPlayed}|${r.wins}|${r.bounties}|${r.rsvpsHonored}`);
    const theirs = oracle.standings(venue, season).map(r => `${r.rank}|${r.name}|${r.points}|${r.gamesPlayed}|${r.wins}|${r.bounties}|${r.rsvpsHonored}`);
    assert.deepEqual(mine, theirs, `${venue} ${season}`);
  }
});

test('standings: default season is the one most recently started; limit trims rows', () => {
  const r = t.getSeasonStandings({ venue: 'corgi', limit: 3 });
  assert.equal(r.season.name, 'Fall 2026');
  assert.equal(r.season.venue, 'Wild Corgi');
  assert.equal(r.standings.length, 3);
  assert.ok(r.playersRanked > 3);
});

test('standings: the unfinalized game is flagged, not hidden', () => {
  const r = t.getSeasonStandings({ venue: 'Tight End', season: 'Fall 2026' });
  assert.deepEqual(r.unfinalizedGames, [{ date: '10/20/2026', gameNum: 2 }]);
});

test('history: game points add up to the standings total', () => {
  for (const venue of ['Tight End', 'Wild Corgi']) {
    const { standings } = t.getSeasonStandings({ venue, season: 'Fall 2026' });
    for (const row of standings.slice(0, 25)) {
      const s = t.getPlayerSeasonHistory({ player: row.name, venue, season: 'Fall 2026' }).seasons[0];
      assert.equal(s.games.reduce((a, g) => a + g.pointsCounted, 0), row.points, row.name);
      assert.equal(s.games.reduce((a, g) => a + g.bounties, 0), row.bounties, row.name);
      assert.equal(s.totals.rank, row.rank);
      assert.equal(s.games.filter(g => g.pointsCounted > 0).length, row.gamesPlayed, row.name);
    }
  }
});

test('history: case, spacing and alias variants resolve; near-duplicates are reported', () => {
  const a = t.getPlayerSeasonHistory({ player: '  jordan   WEXMOOR ', venue: 'Tight End' });
  assert.equal(a.player.name, 'Jordan Wexmoor');
  assert.equal(a.player.matchedBy, 'normalized');
  assert.ok(a.player.possibleDuplicates.includes('Jordan W'));
  const b = t.getPlayerSeasonHistory({ player: 'Yaely', venue: 'Wild Corgi' });
  assert.equal(b.player.name, 'Yael Larkspurne');
  assert.equal(b.player.matchedBy, 'alias');
  const c = t.getPlayerSeasonHistory({ player: 'Avery Orrinsb' });
  assert.ok(c.player.possibleDuplicates.includes('Avery Orrinsby'));
  assert.ok(c.seasons.every(s => !s.inStandings && s.totals.gamesPlayed === 0));
});

test('history: both venues when venue is omitted; season by number', () => {
  const r = t.getPlayerSeasonHistory({ player: 'Yael Larkspurne', season: '1' });
  assert.deepEqual(r.seasons.map(s => s.season.venue), ['Tight End', 'Wild Corgi']);
  assert.ok(r.seasons.every(s => s.season.name === 'Summer 2026'));
});

test('errors: unknown player, venue, season; bad date; no game; not played', () => {
  assert.equal(code(() => t.getPlayerSeasonHistory({ player: 'Morgan Quillsby' })), 'unknown_player');
  try { t.getPlayerSeasonHistory({ player: 'Jordan Wexmore' }); } catch (e) { assert.equal(e.details.suggestions[0], 'Jordan Wexmoor'); }
  assert.equal(code(() => t.getSeasonStandings({ venue: 'Lucky Duck' })), 'unknown_venue');
  assert.equal(code(() => t.getSeasonStandings({ venue: '' })), 'invalid_argument');
  assert.equal(code(() => t.getSeasonStandings({ venue: 'Tight End', season: 'Spring 2025' })), 'unknown_season');
  assert.equal(code(() => t.getPlayerSeasonHistory({ player: 'Jordan Wexmoor', season: 'Winter 2030' })), 'unknown_season');
  assert.equal(code(() => t.getGameSeating({ venue: 'Tight End', date: '13/45/2026', game: 1 })), 'invalid_date');
  assert.equal(code(() => t.getGameSeating({ venue: 'Tight End', date: '10/21/2026', game: 1 })), 'no_game');
  assert.equal(code(() => t.getGameSeating({ venue: 'Tight End', date: '11/10/2026', game: 1 })), 'game_not_played');
  assert.equal(code(() => t.getGameSeating({ venue: 'Tight End', date: '10/20/2026', game: 3 })), 'invalid_argument');
  assert.equal(code(() => t.getGameStructure({ date: '10/20/2026' })), 'invalid_argument');
});

test('seating, regular night: field in arrival order, final table of ten', () => {
  const r = t.getGameSeating({ venue: 'Tight End', date: '2026-09-08', game: 1 });
  assert.equal(r.kind, 'regular');
  assert.equal(r.event.date, '9/8/2026');
  assert.equal(r.entrants, r.field.length);
  assert.ok(r.field.every((f, i) => f.arrival === i + 1));
  for (let i = 1; i < r.field.length; i++) assert.ok(r.field[i - 1].checkedInAt <= r.field[i].checkedInAt);
  assert.equal(r.finalTable.length, 10);
  assert.ok(r.finalized);
  assert.equal(r.field.filter(f => f.finish !== null).length, 10);
});

test('seating, unfinalized game reports finalized:false', () => {
  const r = t.getGameSeating({ venue: 'Tight End', date: '10/20/2026', game: 2 });
  assert.equal(r.finalized, false);
  assert.ok(r.finalTable.every(f => f.seasonPoints === null));
});

test('seating, championship night: 20 main seats, director move honored', () => {
  const r = t.getGameSeating({ venue: 'Tight End', date: '8/11/2026', game: 1 });
  assert.equal(r.kind, 'championship');
  assert.equal(r.event.season.name, 'Summer 2026');
  assert.equal(r.summary.mainSeats, 20);
  const moved = r.sections.consolation.find(e => e.movedByDirector);
  assert.ok(moved, 'the director-moved alternate sits in consolation');
  assert.equal(moved.name.toLowerCase(), Object.keys(data.champ_overrides.find(o => o.venue === 'Tight End')).find(k => k.startsWith('g1_')).slice(3));
  const g2 = t.getGameSeating({ venue: 'Tight End', date: '8/11/2026', game: 2 });
  assert.equal(g2.sections.playing.length, 20);
  assert.match(g2.rankedBy, /points/);
});

test('structure: levels, start minutes, points and tie rule', () => {
  const r = t.getGameStructure({ venue: 'Tight End', date: '11/17/2026' });
  assert.equal(r.event.type, 'Championship');
  assert.equal(r.event.status, 'scheduled');
  assert.equal(r.event.countsTowardSeason, false);
  const lv = r.blindStructure.levels;
  for (let i = 1; i < lv.length; i++) assert.equal(lv[i].startsAtMinute, lv[i - 1].startsAtMinute + lv[i - 1].minutes);
  const r6 = lv.find(l => l.name === 'Round 6');
  assert.deepEqual([r6.smallBlind, r6.bigBlind], [1000, 2000]);
  assert.equal(r.scoring.placementBonus.find(p => p.rank === 3).totalWithAttendance, 90);
  assert.equal(tiePoints(4, 3), 60);
  assert.equal(tiePoints(9, 2), 15);
  assert.equal(tiePoints(10, 2), 5);
  assert.equal(t.getGameStructure({}).event, null);
});
