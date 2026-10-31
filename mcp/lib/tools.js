'use strict';
// The four read-only tools, as plain functions over the loaded data. server.js
// wraps them in MCP; the tests and the eval call them directly or through MCP.

const { ToolError } = require('./errors');
const { resolveVenue, resolveSeason, requireDate, dateKey, parseDate, inWindow, nonSeasonDates, isRegular, seasonSummary } = require('./data');
const { buildIndex, resolvePlayer, norm } = require('./names');
const { scoreSeason, tiePoints, BONUS_POINTS, ATTENDANCE_POINTS } = require('./standings');
const { seating, clock } = require('./shared-modules');

const STANDINGS_ORDER = 'points desc, then games played desc, then RSVPs honored desc, then name A-Z';
const TIE_RULE = 'Players tie when points, games played and RSVPs honored are all equal; tied players share the higher rank and the next rank is skipped.';

function createTools(data) {
  const index = buildIndex(data);
  const cache = new Map();
  const scored = (season) => {
    if (!cache.has(season.id)) cache.set(season.id, scoreSeason(data, season));
    return cache.get(season.id);
  };

  // ── 1. season standings ──────────────────────────────────────────────────
  function getSeasonStandings({ venue, season, limit } = {}) {
    const v = resolveVenue(data, venue);
    const s = resolveSeason(data, v, season);
    const r = scored(s);
    const rows = r.standings.slice(0, limit && limit > 0 ? limit : undefined);
    return {
      season: r.season,
      playersRanked: r.standings.length,
      gamesCounted: r.gamesCounted,
      unfinalizedGames: r.unfinalizedGames,
      order: STANDINGS_ORDER,
      tieRule: TIE_RULE,
      standings: rows.map(x => ({ rank: x.rank, tied: x.tied, name: x.name, points: x.points, gamesPlayed: x.gamesPlayed, wins: x.wins, bounties: x.bounties, rsvpsHonored: x.rsvpsHonored, qualified: x.qualified }))
    };
  }

  // ── 2. one player's season history ───────────────────────────────────────
  function getPlayerSeasonHistory({ player, venue, season } = {}) {
    const who = resolvePlayer(index, player);
    const venues = venue ? [resolveVenue(data, venue)] : data.venues;
    const seasons = [];
    const misses = [];
    for (const v of venues) {
      try { seasons.push(resolveSeason(data, v, season)); }
      catch (e) { if (e.code === 'unknown_season') misses.push(e); else throw e; }
    }
    if (!seasons.length) {
      throw new ToolError('unknown_season', `No season "${season}"${venue ? ` at ${venues[0]}` : ' at any venue'}.`,
        { availableSeasons: [...new Set(misses.flatMap(e => e.details.availableSeasons))] });
    }
    return {
      player: { name: who.name, matchedBy: who.matchedBy, possibleDuplicates: who.possibleDuplicates },
      seasons: seasons.map(s => seasonForPlayer(s, who))
    };
  }

  function seasonForPlayer(s, who) {
    const r = scored(s);
    const st = r.perPlayer[who.key];
    const standing = r.standings.find(x => norm(x.name) === who.key) || null;
    const skip = nonSeasonDates(data, s.venue);
    const games = new Map();
    const game = (date, gameNum) => {
      const k = `${date}#${gameNum}`;
      if (!games.has(k)) games.set(k, { date, gameNum, checkedIn: false, rsvp: null, finish: null, numTied: null, pointsCounted: 0, bounties: 0, finalized: null });
      return games.get(k);
    };
    // Check-ins and RSVPs in the window, so a game with no points still shows.
    for (const c of data.checkins) {
      if (c.venue !== s.venue || norm(c.player) !== who.key || c.status === 'removed') continue;
      if (!isRegular(c.gameType) || skip.has(dateKey(c.date)) || !inWindow(c.date, s.startDate, s.endDate)) continue;
      game(dateKey(c.date), c.gameNum).checkedIn = true;
    }
    for (const rv of data.rsvps) {
      if (rv.venue !== s.venue || norm(rv.player) !== who.key) continue;
      if (skip.has(dateKey(rv.date)) || !inWindow(rv.date, s.startDate, s.endDate)) continue;
      game(dateKey(rv.date), rv.gameNum).rsvp = rv.status;
    }
    for (const ev of (st ? st.events : [])) {
      const g = game(ev.date, ev.gameNum);
      if (ev.kind === 'placement') { g.finish = ev.rank; g.numTied = ev.numTied; g.pointsCounted += ev.points; g.finalized = ev.finalized; }
      if (ev.kind === 'attendance') { g.pointsCounted += ev.points; g.finalized = true; }
      if (ev.kind === 'bounty') g.bounties += ev.count;
    }
    const list = [...games.values()].sort((a, b) => parseDate(a.date) - parseDate(b.date) || a.gameNum - b.gameNum);
    list.forEach(g => {
      g.played = g.checkedIn || g.finish !== null || g.pointsCounted > 0;
      g.tiedFinish = !!(g.numTied && g.numTied > 1);
      if (g.finalized === null && g.played) g.finalized = false;
    });
    const placements = list.filter(g => g.finish !== null);
    return {
      season: r.season,
      inStandings: !!standing,
      totals: {
        rank: standing ? standing.rank : null,
        tied: standing ? standing.tied : false,
        playersRanked: r.standings.length,
        points: standing ? standing.points : 0,
        gamesPlayed: standing ? standing.gamesPlayed : 0,
        wins: standing ? standing.wins : 0,
        bounties: standing ? standing.bounties : 0,
        rsvpsHonored: standing ? standing.rsvpsHonored : 0,
        finalTables: placements.length,
        bestFinish: placements.length ? Math.min(...placements.map(g => g.finish)) : null
      },
      games: list
    };
  }

  // ── 3. seating for one game ──────────────────────────────────────────────
  function findNight(venue, date) {
    const v = resolveVenue(data, venue);
    const d = requireDate(date);
    const night = data.schedule.find(r => (r.venue || r.location) === v && dateKey(r.date) === d);
    if (!night) {
      const target = parseDate(d);
      const nearest = data.schedule.filter(r => (r.venue || r.location) === v)
        .sort((a, b) => Math.abs(parseDate(a.date) - target) - Math.abs(parseDate(b.date) - target))
        .slice(0, 3).map(r => r.date);
      throw new ToolError('no_game', `${v} has no event on ${d}.`, { nearestEventDates: nearest });
    }
    return { venue: v, date: d, type: night.type || 'Regular', theme: night.theme || '' };
  }
  const played = (n, gameNum) => data.checkins.some(c => c.venue === n.venue && dateKey(c.date) === n.date && (gameNum === undefined || c.gameNum === gameNum));

  function getGameSeating({ venue, date, game } = {}) {
    const n = findNight(venue, date);
    const g = Number(game);
    if (![1, 2].includes(g)) throw new ToolError('invalid_argument', 'game must be 1 or 2.');
    if (!played(n)) throw new ToolError('game_not_played', `${n.venue} ${n.date} (${n.type}) is scheduled but has no check-ins yet.`, { eventType: n.type });
    return n.type === 'Championship' ? championshipSeating(n, g) : regularSeating(n, g);
  }

  function regularSeating(n, g) {
    const at = (r) => r.createdAt || null;
    const field = data.checkins
      .filter(c => c.venue === n.venue && dateKey(c.date) === n.date && c.gameNum === g && c.status !== 'removed')
      .sort((a, b) => String(at(a)).localeCompare(String(at(b))) || a.player.localeCompare(b.player));
    const elims = data.eliminations.filter(e => e.venue === n.venue && dateKey(e.date) === n.date && e.gameNum === g && e.status !== 'removed');
    const finishOf = (name) => elims.find(e => norm(e.player) === norm(name)) || null;
    const finalized = elims.length > 0 && elims.every(e => e.status === 'processed');
    const seen = new Set();
    const rows = [];
    for (const c of field) {
      if (seen.has(norm(c.player))) continue;
      seen.add(norm(c.player));
      const f = finishOf(c.player);
      rows.push({ arrival: rows.length + 1, name: c.player, checkedInAt: at(c), finish: f ? f.rank : null, manuallyAdded: !!c.manuallyAdded });
    }
    if (!rows.length) throw new ToolError('game_not_played', `${n.venue} ${n.date} game ${g} has no check-ins.`, { eventType: n.type });
    const finalTable = elims.slice().sort((a, b) => a.rank - b.rank || a.player.localeCompare(b.player)).map(e => ({
      rank: e.rank, name: e.player, tied: (e.numTied || elims.filter(o => o.rank === e.rank).length) > 1,
      seasonPoints: e.bonusPoints !== null && e.bonusPoints !== undefined ? e.bonusPoints + ATTENDANCE_POINTS : null
    }));
    return {
      event: { venue: n.venue, date: n.date, game: g, type: n.type },
      kind: 'regular',
      finalized,
      seatsRecorded: false,
      note: 'Regular nights draw for seats at the table (the clock\'s first level), so seat numbers are not recorded. The field is listed in check-in order with each finish.',
      entrants: rows.length,
      field: rows,
      finalTable
    };
  }

  function championshipSeating(n, g) {
    const s = data.seasons.find(x => x.venue === n.venue && dateKey(x.championshipDate) === n.date);
    if (!s) throw new ToolError('no_game', `No season names ${n.date} as its championship night at ${n.venue}.`);
    const season = resolveSeason(data, n.venue, s.id);
    const standings = scored(season).standings.map(x => ({ ...x }));
    const league = seating.buildChampionshipRanking(standings);
    const ranked = g === 1 ? seating.rankByBounties(league) : league;
    const att = {}, time = {};
    const rows = (coll, status) => data[coll].filter(r => r.venue === n.venue && dateKey(r.date) === n.date && r.gameNum === g && r.status === status);
    rows('checkins', 'active').forEach(r => { att[r.player] = 'ci'; const t = Date.parse(r.createdAt); if (Number.isFinite(t) && !(r.player in time && time[r.player] <= t)) time[r.player] = t; });
    rows('rsvps', 'active').forEach(r => { if (!att[r.player]) att[r.player] = 'rsvp'; });
    rows('rsvps', 'declined').forEach(r => { if (!att[r.player]) att[r.player] = 'declined'; });
    const docId = (n.venue + '_' + n.date).replace(/[\s/]/g, '_');
    const doc = data.champ_overrides.find(d => d.id === docId) || {};
    const raw = { 1: {}, 2: {} };
    Object.entries(doc).forEach(([k, val]) => { const m = typeof val === 'string' && k.match(/^g(\d)_(.+)$/); if (m) raw[m[1]][m[2]] = val; });
    const { overrides, doors, seats } = seating.splitOverrides(raw);
    const state = seating.buildSeating({ ranked, attendance: att, checkinTime: time, overrides: overrides[g], seats: seats[g], doorsClosed: doors[g], scoreField: g === 1 ? 'bounties' : 'points' });
    const entry = (e) => ({
      seasonRank: e.origRank || null, displayRank: e.dispRank || e.origRank || null, name: e.name, score: e.score,
      status: e.status === 'ci' ? 'checked-in' : e.status === 'rsvp' ? 'rsvp' : e.status === 'declined' ? 'declined' : 'no-response',
      checkedInAt: Number.isFinite(e.checkinAt) ? new Date(e.checkinAt).toISOString() : null,
      out: !!e.out, movedByDirector: !!e.manual, seat: e.seat || null
    });
    return {
      event: { venue: n.venue, date: n.date, game: g, type: n.type, season: seasonSummary(season) },
      kind: 'championship',
      rankedBy: g === 1 ? 'season bounties (then games played, RSVPs honored, name)' : 'season points, berth holders (a win this season) first (then games played, RSVPs honored, name)',
      doorsClosed: !!doors[g],
      sections: {
        playing: state.playing.map(entry),
        cleared: state.cleared.map(entry),
        onDeck: state.ondeck.map(entry),
        consolation: state.consolation.map(entry),
        consolationWaitlist: state.consolWait.map(entry),
        out: state.out.map(entry)
      },
      summary: {
        mainSeats: state.meta.seats, mainFilled: state.meta.filled, openNow: state.meta.openNow, unconfirmed: state.meta.unconfirmed,
        consolationSeats: state.meta.consolSeats, consolationFilled: state.meta.consolFilled, consolationWaiting: state.meta.consolWaiting,
        checkedIn: state.meta.counts.ci, rsvps: state.meta.counts.rsvp, declined: state.meta.counts.declined
      }
    };
  }

  // ── 4. structure and rules ───────────────────────────────────────────────
  function getGameStructure({ venue, date } = {}) {
    let event = null;
    let structureId = clock.DEFAULT_STRUCTURE_ID;
    if (date && !venue) throw new ToolError('invalid_argument', 'date needs a venue.');
    if (venue) {
      const v = resolveVenue(data, venue);
      const tc = data.timerClocks.find(t => t.venue === v);
      if (tc && clock.STRUCTURES[tc.structure]) structureId = tc.structure;
      if (date) {
        const n = findNight(v, date);
        const season = data.seasons.find(s => s.venue === v && (dateKey(s.championshipDate) === n.date || inWindow(n.date, s.startDate, s.endDate)));
        event = { venue: v, date: n.date, type: n.type, theme: n.theme || null, season: season ? season.name : null, games: 2, status: played(n) ? 'played' : 'scheduled', countsTowardSeason: n.type === 'Regular' };
      } else {
        event = { venue: v, date: null, type: null, theme: null, season: null, games: 2, status: null, countsTowardSeason: null };
      }
    }
    const st = clock.STRUCTURES[structureId];
    let minute = 0, round = 0, brk = 0;
    const levels = st.levels.map((l, i) => {
      const label = l.isPreGame ? 'Pre-game' : l.isBreak ? `Break ${++brk}` : `Round ${++round}`;
      const out = { index: i, label, name: l.name, minutes: l.duration, startsAtMinute: minute, smallBlind: l.small || null, bigBlind: l.big || null,
        isBreak: !!l.isBreak, isPreGame: !!l.isPreGame, chipUp: l.chipUp || null };
      minute += l.duration;
      return out;
    });
    return {
      event,
      blindStructure: { id: st.id, name: st.name, appliesTo: 'both games of a league night', levels, totalScheduledMinutes: minute },
      scoring: {
        finalTableSize: 10,
        placementBonus: Object.entries(BONUS_POINTS).map(([rank, bonus]) => ({ rank: Number(rank), bonus, totalWithAttendance: bonus + ATTENDANCE_POINTS })),
        attendancePoints: ATTENDANCE_POINTS,
        attendanceRule: 'Every player in a finalized Regular game earns 10 attendance points; a final-table finish adds its bonus on top. Championship and Big Stack nights do not count toward the season.',
        tieRule: 'Players tied at a finish split the bonuses of the places they cover (for example a two-way tie for 2nd shares 2nd and 3rd), averaged and rounded UP to the nearest 5.',
        tieExamples: [[2, 2], [4, 3], [9, 2]].map(([rank, n]) => ({ rank, numTied: n, bonusEach: tiePoints(rank, n) })),
        standingsOrder: STANDINGS_ORDER,
        standingsTieRule: TIE_RULE,
        winDefinition: 'A win is a 1st-place finish; any win this season gives a championship berth.'
      },
      championship: {
        mainTableSeats: seating.ROSTER_SIZE,
        consolationSeats: seating.CONSOL_SEATS,
        game1RankedBy: 'season bounties',
        game2RankedBy: 'season points (berth holders first)',
        openSeatRule: 'A seat opens when its holder declines, or when doors close and they have not checked in. Open seats go to checked-in alternates (rank 21 and below) in rank order.',
        consolationRule: 'Consolation seats go to checked-in players without a main seat, in arrival order; past the cap they wait in arrival order.'
      }
    };
  }

  return { getSeasonStandings, getPlayerSeasonHistory, getGameSeating, getGameStructure, index };
}

module.exports = { createTools };
