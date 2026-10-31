'use strict';
// Input and output schemas for the four tools. The MCP SDK publishes them as
// JSON Schema in tools/list and validates every structured result against the
// output schema before it leaves the server.

const { z } = require('zod');

const venue = z.string().describe('Venue name: "Tight End" (Tuesdays) or "Wild Corgi" (Thursdays). Case-insensitive; a unique part such as "corgi" works.');
const season = z.string().describe('Season name ("Fall 2026"), number ("2") or id. Omit for the venue\'s current season.');
const date = z.string().describe('Night of the event, M/D/YYYY (10/20/2026) or YYYY-MM-DD (2026-10-20).');

const seasonInfo = z.object({
  seasonId: z.string(), name: z.string(), venue: z.string(), seasonNumber: z.number().nullable(),
  startDate: z.string(), endDate: z.string().nullable(), championshipDate: z.string().nullable()
});
const gameRef = z.object({ date: z.string(), gameNum: z.number() });

const standingRow = z.object({
  rank: z.number().describe('Shared by tied players; the next rank is skipped.'),
  tied: z.boolean(), name: z.string(),
  points: z.number().describe('Season points: placement bonus + 10 per game played.'),
  gamesPlayed: z.number(), wins: z.number(), bounties: z.number(),
  rsvpsHonored: z.number().describe('RSVPs the player kept by playing that game (second tiebreak).'),
  qualified: z.boolean().describe('Holds a championship berth (won a game this season).')
});

const standingsOut = {
  season: seasonInfo,
  playersRanked: z.number(),
  gamesCounted: z.number(),
  unfinalizedGames: z.array(gameRef).describe('Games whose results are in but not finalized; their placements already count, as on the live leaderboard.'),
  order: z.string(), tieRule: z.string(),
  standings: z.array(standingRow)
};

const historyGame = z.object({
  date: z.string(), gameNum: z.number(),
  played: z.boolean(), checkedIn: z.boolean(),
  rsvp: z.string().nullable().describe('RSVP status for that game, if any: converted (kept), active (no-show) or declined.'),
  finish: z.number().nullable().describe('Final-table place 1-10, or null if the player did not reach the final table.'),
  numTied: z.number().nullable(), tiedFinish: z.boolean(),
  pointsCounted: z.number().describe('Season points this game contributed.'),
  bounties: z.number(),
  finalized: z.boolean().nullable()
});
const historyOut = {
  player: z.object({
    name: z.string().describe('Canonical name the input resolved to.'),
    matchedBy: z.enum(['exact', 'normalized', 'alias']),
    possibleDuplicates: z.array(z.string()).describe('Roster rows that look like the same person (typos, short forms). Not merged.')
  }),
  seasons: z.array(z.object({
    season: seasonInfo,
    inStandings: z.boolean(),
    totals: z.object({
      rank: z.number().nullable(), tied: z.boolean(), playersRanked: z.number(), points: z.number(), gamesPlayed: z.number(),
      wins: z.number(), bounties: z.number(), rsvpsHonored: z.number(), finalTables: z.number(), bestFinish: z.number().nullable()
    }),
    games: z.array(historyGame).describe('Every game in the season window the player checked in for, RSVP\'d to, placed in, or took a bounty in.')
  }))
};

const champEntry = z.object({
  seasonRank: z.number().nullable(), displayRank: z.number().nullable(), name: z.string(), score: z.number().nullable(),
  status: z.enum(['checked-in', 'rsvp', 'declined', 'no-response']), checkedInAt: z.string().nullable(),
  out: z.boolean().describe('Gave up the seat (declined, or doors closed before they arrived).'),
  movedByDirector: z.boolean(), seat: z.string().nullable()
});
const seatingOut = {
  event: z.object({ venue: z.string(), date: z.string(), game: z.number(), type: z.string(), season: seasonInfo.optional() }),
  kind: z.enum(['regular', 'championship']),
  // regular
  finalized: z.boolean().optional(),
  seatsRecorded: z.boolean().optional(),
  note: z.string().optional(),
  entrants: z.number().optional(),
  field: z.array(z.object({ arrival: z.number(), name: z.string(), checkedInAt: z.string().nullable(), finish: z.number().nullable(), manuallyAdded: z.boolean() })).optional(),
  finalTable: z.array(z.object({ rank: z.number(), name: z.string(), tied: z.boolean(), seasonPoints: z.number().nullable() })).optional(),
  // championship
  rankedBy: z.string().optional(),
  doorsClosed: z.boolean().optional(),
  sections: z.object({
    playing: z.array(champEntry), cleared: z.array(champEntry), onDeck: z.array(champEntry),
    consolation: z.array(champEntry), consolationWaitlist: z.array(champEntry), out: z.array(champEntry)
  }).optional(),
  summary: z.object({
    mainSeats: z.number(), mainFilled: z.number(), openNow: z.number(), unconfirmed: z.number(),
    consolationSeats: z.number(), consolationFilled: z.number(), consolationWaiting: z.number(),
    checkedIn: z.number(), rsvps: z.number(), declined: z.number()
  }).optional()
};

const structureOut = {
  event: z.object({
    venue: z.string(), date: z.string().nullable(), type: z.string().nullable(), theme: z.string().nullable(), season: z.string().nullable(),
    games: z.number(), status: z.enum(['played', 'scheduled']).nullable(), countsTowardSeason: z.boolean().nullable()
  }).nullable(),
  blindStructure: z.object({
    id: z.string(), name: z.string(), appliesTo: z.string(), totalScheduledMinutes: z.number(),
    levels: z.array(z.object({
      index: z.number(), label: z.string().describe('"Round N", "Break N" or "Pre-game".'), name: z.string(), minutes: z.number(),
      startsAtMinute: z.number().describe('Minutes from the start of the clock (pre-game included).'),
      smallBlind: z.number().nullable(), bigBlind: z.number().nullable(), isBreak: z.boolean(), isPreGame: z.boolean(), chipUp: z.string().nullable()
    }))
  }),
  scoring: z.object({
    finalTableSize: z.number(),
    placementBonus: z.array(z.object({ rank: z.number(), bonus: z.number(), totalWithAttendance: z.number() })),
    attendancePoints: z.number(), attendanceRule: z.string(), tieRule: z.string(),
    tieExamples: z.array(z.object({ rank: z.number(), numTied: z.number(), bonusEach: z.number() })),
    standingsOrder: z.string(), standingsTieRule: z.string(), winDefinition: z.string()
  }),
  championship: z.object({
    mainTableSeats: z.number(), consolationSeats: z.number(), game1RankedBy: z.string(), game2RankedBy: z.string(),
    openSeatRule: z.string(), consolationRule: z.string()
  })
};

const TOOLS = {
  get_season_standings: {
    title: 'Season standings',
    description: 'Ranked season standings for one venue, computed from game records the way the league leaderboard computes them. ' +
      'Returns every ranked player (or the top `limit`) with points, games played, wins, bounties and RSVPs honored. ' +
      'Errors: unknown_venue, unknown_season (with the venue\'s available seasons).',
    inputSchema: { venue, season: season.optional(), limit: z.number().int().positive().optional().describe('Return only the first N rows.') },
    outputSchema: standingsOut
  },
  get_player_season_history: {
    title: 'Player season history',
    description: 'One player\'s season: totals (rank, points, games, wins, bounties, best finish) and every game with finish, points and bounties. ' +
      'Names match exactly after trimming and lowercasing, or by alias; nothing is guessed. Omit venue to get the season at both venues. ' +
      'Errors: unknown_player (with suggestions), ambiguous_player, unknown_venue, unknown_season.',
    inputSchema: { player: z.string().describe('Player name or alias.'), venue: venue.optional(), season: season.optional() },
    outputSchema: historyOut
  },
  get_game_seating: {
    title: 'Game seating',
    description: 'Who sat in one game. Regular nights: the field in check-in order with each finish and the final table (seats are drawn at the table and not recorded). ' +
      'Championship nights: the seating chart the director sees, sections playing, cleared, onDeck, consolation, consolationWaitlist, out. ' +
      'Errors: unknown_venue, invalid_date, no_game (with nearest event dates), game_not_played (scheduled, no check-ins yet).',
    inputSchema: { venue, date, game: z.number().int().min(1).max(2).describe('Game 1 or 2 of the night.') },
    outputSchema: seatingOut
  },
  get_game_structure: {
    title: 'Game structure and rules',
    description: 'Blind levels (minutes, start minute, blinds, breaks, chip-ups), the points table, tie and attendance rules, and championship seating rules. ' +
      'With venue and date, also the event type that night (Regular, Championship) and whether it counts toward the season. ' +
      'Errors: unknown_venue, invalid_date, no_game.',
    inputSchema: { venue: venue.optional(), date: date.optional() },
    outputSchema: structureOut
  }
};

module.exports = { TOOLS };
