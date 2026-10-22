/**
 * All-In Poker - Cloud Functions
 *
 * Firebase-first architecture:
 * - Callable functions handle ALL business logic
 * - Firestore is the source of truth
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

function hasAdminRole(profile = {}) {
  return profile.role === 'admin' || profile.isAdmin === true;
}

function hasStaffRole(profile = {}) {
  return hasAdminRole(profile) || profile.role === 'staff' || profile.isStaff === true;
}

async function requireRole(request, allowedRoles = []) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const snap = await db.collection('userProfiles').doc(uid).get();
  const profile = snap.exists ? snap.data() || {} : {};

  if (allowedRoles.includes('admin') && hasAdminRole(profile)) return profile;
  if (allowedRoles.includes('staff') && hasStaffRole(profile)) return profile;

  throw new HttpsError('permission-denied', 'Insufficient privileges.');
}

// ===========================================
// CONSTANTS (moved from GAS)
// ===========================================

const BONUS_POINTS = {
  1: 90, 2: 85, 3: 80, 4: 70, 5: 60,
  6: 50, 7: 40, 8: 30, 9: 20, 10: 10
};

const ATTENDANCE_POINTS = 10;

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Normalize date to M/D/YYYY format for consistency
 */
function normalizeDate(dateStr) {
  if (!dateStr) return '';

  // Handle Date objects
  if (dateStr instanceof Date) {
    return `${dateStr.getMonth() + 1}/${dateStr.getDate()}/${dateStr.getFullYear()}`;
  }

  // Handle ISO format (YYYY-MM-DD)
  if (typeof dateStr === 'string' && dateStr.includes('-') && dateStr.length === 10) {
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(m)}/${parseInt(d)}/${y}`;
  }

  return dateStr;
}

/**
 * Normalize event key for Firestore eventContent collection
 * "4/7/2026", "Tight End" → "2026-04-07_tight-end"
 */
function normalizeEventKey(date, venue) {
  const [m, d, y] = (date || '').split('/');
  const v = (venue || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}_${v}`;
}

/**
 * Calculate tie-adjusted bonus points
 */
function calculateTiePoints(rank, numTied) {
  if (rank > 10) return 0;

  let totalPoints = 0;
  for (let r = rank; r < rank + numTied && r <= 10; r++) {
    totalPoints += BONUS_POINTS[r] || 0;
  }

  const avgPoints = totalPoints / numTied;
  return Math.ceil(avgPoints / 5) * 5; // Round up to nearest 5
}

// ===========================================
// DATE + SEASON ELIGIBILITY HELPERS
// ===========================================
// These encapsulate the business rules that protect the season-points model
// from bugs like invalid-date leakage, wrong-season carryover records, and
// double-counted attendance.

/**
 * All venues (Tight End, Wild Corgi) are in Denver — US Mountain time — but
 * Cloud Functions run in UTC. Any "what day is it?" answered with a bare
 * `new Date()` rolls over to tomorrow at 6:00pm MDT / 5:00pm MST — right as
 * check-in opens. That dropped the night's own event from getSchedule's
 * "upcoming" filter (2026-07-17 Big Stack and 2026-07-21 Championship
 * outages). ALWAYS derive "today" through these helpers.
 */
const APP_TIMEZONE = 'America/Denver';

/** Today's date in the venues' timezone as the app's canonical M/D/YYYY string. */
function appTodayStr() {
  return new Date().toLocaleDateString('en-US', { timeZone: APP_TIMEZONE });
}

/**
 * Midnight (server-local) of the venues' current calendar day — comparable
 * against `new Date(scheduleRow.date)` since M/D/YYYY parses as server-local
 * midnight too.
 */
function appToday() {
  return new Date(appTodayStr());
}

/**
 * Allowlist of schedule.type values that grant SEASON attendance points.
 * Anything not in this set is treated as a specialty event and excluded.
 * Missing / null / blank gameType is treated as 'Regular' (matches the
 * default applied at write time everywhere else in the codebase).
 *
 * Add new season-eligible event types here as the league introduces them.
 */
const SEASON_ELIGIBLE_GAME_TYPES = new Set(['Regular']);

/**
 * Allowlist of valid schedule.type values that may be authored directly in
 * Firestore (via saveScheduleEntry). Matches the distinct values that exist
 * in the schedule collection today: Regular (season), Championship, Big Stack.
 * The `type` field has scoring consequences (season eligibility above, and
 * Big Stack exclusion in standings), so it must never be free text — anything
 * not in this set is rejected at write time and coerced to 'Regular'.
 *
 * Add new event types here as the league introduces them.
 */
const VALID_SCHEDULE_TYPES = new Set(['Regular', 'Championship', 'Big Stack']);

function isSeasonEligibleGameType(gameType) {
  const gt = (gameType === undefined || gameType === null || gameType === '')
    ? 'Regular'
    : String(gameType);
  return SEASON_ELIGIBLE_GAME_TYPES.has(gt);
}

/**
 * Parse a date string and return a valid Date, or null if unparseable.
 * Accepts M/D/YYYY and YYYY-MM-DD formats produced elsewhere in the system.
 */
function parseGameDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * True iff dateStr is valid AND falls within [startDate, endDate] inclusive.
 * Explicitly rejects unparseable dates — prevents the "from last" leak where
 * Invalid Date comparisons silently return false and let records through.
 *
 * Each bound is applied independently. An open-ended season (no endDate, and
 * no next season booted yet — see resolveSeasonEnd) is normal and still
 * enforces its start bound. This used to short-circuit to "don't filter at
 * all" when EITHER bound was missing, which quietly turned a season with no
 * endDate into an all-time leaderboard.
 */
function isInSeasonWindow(dateStr, startDate, endDate) {
  const d = parseGameDate(dateStr);
  if (!d) return false;
  const s = parseGameDate(startDate);
  const e = parseGameDate(endDate);
  if (!s && !e) return true; // genuinely unbounded = don't filter
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}

/**
 * Pick the season a venue is currently in — keyed off startDate, NOT endDate.
 *
 * Season ends are fluid in practice (a season routinely runs a week or two
 * past its printed endDate), so "which season has most recently STARTED" is
 * the reliable signal: a season stays current until the next one begins.
 *
 * Keying off endDate — the old behavior — had two failure modes:
 *   1. Booting the next season early (both dates in the future) satisfied
 *      `endDate >= today` and had the latest startDate, so it instantly
 *      hijacked the live leaderboard mid-season.
 *   2. Letting a season's endDate slip past without editing it dropped the
 *      venue to the "most recent endDate" fallback — potentially last season.
 *
 * NOTE: this picks WHICH season is current. The scoring window itself is
 * still [startDate, endDate] via isInSeasonWindow, deliberately — endDate is
 * what keeps championship-night results (played after the regular season)
 * out of regular-season standings. If a season genuinely runs long, extend
 * that season's endDate in Season Admin.
 *
 * @param {Array<Object>} seasons - season docs, each with startDate/endDate
 * @param {Date} [now] - venue-local today; defaults to appToday()
 * @returns {Object|null} the current season, or null if none are usable
 */
function pickCurrentSeason(seasons, now) {
  const today = now || appToday();
  let best = null;

  // Most recently started season that has actually begun.
  (seasons || []).forEach(s => {
    const start = parseGameDate(s && s.startDate);
    if (!start || start > today) return;
    if (!best || start > parseGameDate(best.startDate)) best = s;
  });

  // Nothing has started yet (brand-new venue, or every season is upcoming):
  // fall back to the soonest upcoming season so the app still has a window.
  if (!best) {
    (seasons || []).forEach(s => {
      const start = parseGameDate(s && s.startDate);
      if (!start) return;
      if (!best || start < parseGameDate(best.startDate)) best = s;
    });
  }

  return best;
}

/**
 * Resolve a season's EFFECTIVE end date.
 *
 * endDate is optional. When it's blank, the season runs until the day before
 * the next season for that venue starts — so booting the next season ends the
 * previous one automatically, and a season that runs long needs no edit. When
 * no next season exists yet, the season is open-ended (null) and simply keeps
 * accruing, bounded only by its startDate.
 *
 * An explicitly-set endDate always wins, for the case where you want to close
 * a season early regardless of what comes next.
 *
 * Safe to leave open across Big Stack / Championship nights: those are
 * excluded by event TYPE (isSeasonEligibleGameType), not by the date window.
 *
 * @param {Object} season - the season being resolved
 * @param {Array<Object>} venueSeasons - all seasons for the same venue
 * @returns {{endDate: string|null, derived: boolean}}
 */
function resolveSeasonEnd(season, venueSeasons) {
  if (!season) return { endDate: null, derived: false };

  const explicit = parseGameDate(season.endDate);
  if (explicit) return { endDate: season.endDate, derived: false };

  const start = parseGameDate(season.startDate);
  if (!start) return { endDate: null, derived: false };

  // Earliest season that starts after this one.
  let next = null;
  (venueSeasons || []).forEach(s => {
    if (!s || (s.id && season.id && s.id === season.id)) return;
    const st = parseGameDate(s.startDate);
    if (!st || st <= start) return;
    if (!next || st < parseGameDate(next.startDate)) next = s;
  });

  if (!next) return { endDate: null, derived: true }; // open-ended, nothing next

  // Day before the next season starts. Formatted from date components so a
  // DST boundary can't shift the calendar day.
  const prev = new Date(parseGameDate(next.startDate).getTime() - 24 * 60 * 60 * 1000);
  return {
    endDate: `${prev.getMonth() + 1}/${prev.getDate()}/${prev.getFullYear()}`,
    derived: true
  };
}

/**
 * Canonical M/D/YYYY key for a date string in any supported format, so dates
 * written as M/D/YYYY and YYYY-MM-DD compare equal. Null if unparseable.
 */
function dateKey(dateStr) {
  const d = parseGameDate(dateStr);
  return d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : null;
}

/**
 * The set of dates at a venue whose SCHEDULED event type is not season-
 * eligible — Big Stack and Championship nights.
 *
 * This is a date-level backstop for records that don't carry a trustworthy
 * gameType of their own. Bounty records in particular are never stamped with
 * one (every bounty in the database has gameType undefined, which otherwise
 * defaults to 'Regular'), so without this a championship-night bounty would
 * score once a season's window is left open across it.
 *
 * The schedule's `type` field is the authority here — it's written through a
 * validated allowlist (SCHEDULE_EVENT_TYPES).
 *
 * @returns {Promise<Set<string>>} canonical M/D/YYYY date keys to exclude
 */
async function loadNonSeasonDates(venue) {
  const out = new Set();
  try {
    const snap = await db.collection('schedule').get();
    snap.docs.forEach(doc => {
      const r = doc.data();
      if ((r.venue || r.location) !== venue) return;
      if (isSeasonEligibleGameType(r.type)) return; // Regular nights are fine
      const key = dateKey(r.date);
      if (key) out.add(key);
    });
  } catch (e) {
    // Schedule unreadable — fall back to type-based filtering only rather than
    // failing the leaderboard outright.
    console.error('loadNonSeasonDates error:', e);
  }
  return out;
}

/**
 * One place that answers "which season, and what window" for a venue.
 * Pass a seasonId to pin a specific season, or omit it to auto-detect the
 * current one. Returns the effective window with endDate already resolved.
 *
 * @returns {{season: Object|null, startDate, endDate, endDerived, championshipDate, seasonName, seasonNumber}}
 */
async function resolveSeasonForVenue(venue, seasonId) {
  const snap = await db.collection('seasons').where('venue', '==', venue).get();
  const venueSeasons = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  let season = null;
  if (seasonId) {
    season = venueSeasons.find(s => s.id === seasonId) || null;
    if (!season) {
      // Season id from outside this venue's set (legacy / mislabeled venue)
      const doc = await db.collection('seasons').doc(seasonId).get();
      if (doc.exists) season = { id: doc.id, ...doc.data() };
    }
  } else {
    season = pickCurrentSeason(venueSeasons);
  }

  if (!season) {
    return {
      season: null, startDate: null, endDate: null, endDerived: false,
      championshipDate: 'TBD', seasonName: '', seasonNumber: null
    };
  }

  const { endDate, derived } = resolveSeasonEnd(season, venueSeasons);
  return {
    season,
    startDate: season.startDate ?? null,
    endDate,
    endDerived: derived,
    championshipDate: season.championshipDate || 'TBD',
    seasonName: season.name || '',
    seasonNumber: season.seasonNumber ?? null
  };
}

/**
 * Season-point eligibility for attendance. A checkin only awards attendance
 * points if EVERY condition is true. Any no-match short-circuits to false.
 *
 * @param {Object} checkin - Firestore checkin document data
 * @param {Object} seasonInfo - { startDate, endDate, seasonNumber?, venue }
 * @param {boolean} hasEliminationForSameGame - already counted via elimination
 * @returns {boolean}
 */
function isSeasonAttendanceEligible(checkin, seasonInfo, hasEliminationForSameGame) {
  if (!checkin) return false;
  // Record status: accept undefined/null/active/processed/checked-in (historical admin-added)
  // Only reject explicit 'removed'.
  if (checkin.status === 'removed') return false;
  // Must be flagged as attendance-only (the flag the attendance loop keys on).
  if (checkin.attendanceOnly !== true) return false;
  // Venue must match the active season's venue.
  if (seasonInfo && seasonInfo.venue && checkin.venue !== seasonInfo.venue) return false;
  // Date must be valid and inside the season window.
  if (!isInSeasonWindow(checkin.date, seasonInfo?.startDate, seasonInfo?.endDate)) return false;
  // If the record carries an explicit season number, it must match the active season.
  if (checkin.season !== undefined && checkin.season !== null
      && seasonInfo && seasonInfo.seasonNumber !== undefined && seasonInfo.seasonNumber !== null
      && Number(checkin.season) !== Number(seasonInfo.seasonNumber)) {
    return false;
  }
  // Only allowlisted event types count for season attendance points.
  // Anything not explicitly in SEASON_ELIGIBLE_GAME_TYPES is excluded.
  if (!isSeasonEligibleGameType(checkin.gameType)) return false;
  // Prevent double-count: if player got elimination points for this game, the
  // elimination already bundles the ATTENDANCE_POINTS bonus.
  if (hasEliminationForSameGame) return false;
  return true;
}

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy name matching
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Common nickname mappings for first name matching
 */
const NICKNAME_MAP = {
  'dan': ['daniel', 'danny'],
  'daniel': ['dan', 'danny'],
  'danny': ['dan', 'daniel'],
  'mike': ['michael', 'mikey'],
  'michael': ['mike', 'mikey'],
  'rob': ['robert', 'robbie', 'bob', 'bobby'],
  'robert': ['rob', 'robbie', 'bob', 'bobby'],
  'bob': ['robert', 'rob', 'bobby'],
  'will': ['william', 'bill', 'billy'],
  'william': ['will', 'bill', 'billy'],
  'bill': ['william', 'will', 'billy'],
  'jim': ['james', 'jimmy'],
  'james': ['jim', 'jimmy'],
  'joe': ['joseph', 'joey'],
  'joseph': ['joe', 'joey'],
  'tom': ['thomas', 'tommy'],
  'thomas': ['tom', 'tommy'],
  'chris': ['christopher'],
  'christopher': ['chris'],
  'matt': ['matthew'],
  'matthew': ['matt'],
  'nick': ['nicholas', 'nico'],
  'nicholas': ['nick', 'nico'],
  'alex': ['alexander', 'alexandra'],
  'alexander': ['alex'],
  'sam': ['samuel', 'samantha'],
  'samuel': ['sam'],
  'tony': ['anthony'],
  'anthony': ['tony'],
  'steve': ['steven', 'stephen'],
  'steven': ['steve'],
  'stephen': ['steve'],
  'dave': ['david'],
  'david': ['dave'],
  'ed': ['edward', 'eddie'],
  'edward': ['ed', 'eddie'],
  'greg': ['gregory'],
  'gregory': ['greg'],
  'jeff': ['jeffrey'],
  'jeffrey': ['jeff'],
  'jon': ['jonathan', 'john'],
  'jonathan': ['jon'],
  'john': ['jon', 'johnny'],
  'josh': ['joshua'],
  'joshua': ['josh'],
  'pat': ['patrick', 'patricia'],
  'patrick': ['pat'],
  'pete': ['peter'],
  'peter': ['pete'],
  'rick': ['richard', 'ricky'],
  'richard': ['rick', 'ricky', 'dick'],
  'ben': ['benjamin'],
  'benjamin': ['ben'],
  'jake': ['jacob'],
  'jacob': ['jake']
};

/**
 * Check if two first names are equivalent (nicknames/abbreviations)
 */
function areFirstNamesEquivalent(name1, name2) {
  const n1 = name1.toLowerCase();
  const n2 = name2.toLowerCase();

  if (n1 === n2) return true;

  // Check if one is prefix of other (Dan -> Daniel)
  if (n1.startsWith(n2) || n2.startsWith(n1)) return true;

  // Check nickname mapping
  const nicknames = NICKNAME_MAP[n1];
  if (nicknames && nicknames.includes(n2)) return true;

  return false;
}

/**
 * Check if two last names match (including initial abbreviation)
 */
function areLastNamesEquivalent(name1, name2) {
  const n1 = name1.toLowerCase();
  const n2 = name2.toLowerCase();

  if (n1 === n2) return true;

  // Check if one is just an initial
  if (n1.length === 1 && n2.startsWith(n1)) return true;
  if (n2.length === 1 && n1.startsWith(n2)) return true;

  // Check Levenshtein for typos (threshold 80%)
  const maxLen = Math.max(n1.length, n2.length);
  const distance = levenshteinDistance(n1, n2);
  if (1 - (distance / maxLen) >= 0.8) return true;

  return false;
}

/**
 * Calculate smart name similarity accounting for nicknames and initials
 */
function calculateNameSimilarity(name1, name2) {
  const parts1 = name1.toLowerCase().trim().split(/\s+/);
  const parts2 = name2.toLowerCase().trim().split(/\s+/);

  // Single word names - use Levenshtein
  if (parts1.length === 1 || parts2.length === 1) {
    const maxLen = Math.max(name1.length, name2.length);
    const distance = levenshteinDistance(name1.toLowerCase(), name2.toLowerCase());
    return 1 - (distance / maxLen);
  }

  // Multi-part names: check first and last separately
  const first1 = parts1[0];
  const first2 = parts2[0];
  const last1 = parts1[parts1.length - 1];
  const last2 = parts2[parts2.length - 1];

  // Check for nickname/abbreviation matches
  const firstMatch = areFirstNamesEquivalent(first1, first2);
  const lastMatch = areLastNamesEquivalent(last1, last2);

  if (firstMatch && lastMatch) {
    // Both first and last match (via nickname/initial) - high confidence
    return 0.95;
  }

  if (lastMatch && (first1.charAt(0) === first2.charAt(0))) {
    // Last names match and first names start with same letter
    return 0.85;
  }

  if (firstMatch) {
    // First names match, check last name similarity
    const lastMaxLen = Math.max(last1.length, last2.length);
    const lastDistance = levenshteinDistance(last1, last2);
    const lastSim = 1 - (lastDistance / lastMaxLen);
    if (lastSim >= 0.7) return 0.5 + (lastSim * 0.4);
  }

  // Fall back to overall Levenshtein
  const maxLen = Math.max(name1.length, name2.length);
  const distance = levenshteinDistance(name1.toLowerCase(), name2.toLowerCase());
  return 1 - (distance / maxLen);
}

/**
 * Find similar player names using fuzzy matching
 * Returns array of {name, similarity, matchType} for names within threshold
 */
function findSimilarNames(targetName, playerNames, threshold = 0.8) {
  const targetLower = targetName.toLowerCase().trim();
  const similar = [];

  for (const name of playerNames) {
    const nameLower = name.toLowerCase().trim();
    if (nameLower === targetLower) continue; // Skip exact matches

    const similarity = calculateNameSimilarity(targetName, name);

    if (similarity >= threshold) {
      similar.push({ name, similarity: Math.round(similarity * 100) });
    }
  }

  return similar.sort((a, b) => b.similarity - a.similarity);
}

// ===========================================
// CALLABLE FUNCTIONS - PHASE 1
// ===========================================

/**
 * Check in a player for a game
 * Writes to Firebase (source of truth)
 */
// The bodies of checkin, removeCheckin, recordBounty, recordElimination and
// createAnnouncement are named functions (doCheckin etc.) so other server
// features can apply a confirmed change through the exact code the kiosk,
// Tonight and Director run. The callables below are wrappers.
exports.checkin = onCall(async (request) => doCheckin(request.data || {}));
async function doCheckin(data) {
  const { player, date, gameNum, venue } = data;

  if (!player || !date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields: player, date, gameNum, venue');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();

  try {
    // Check for duplicate
    const existingCheckin = await db.collection('checkins')
      .where('playerLower', '==', playerLower)
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', '==', 'active')
      .limit(1)
      .get();

    if (!existingCheckin.empty) {
      return {
        status: 'duplicate',
        message: `${player} is already checked in for Game ${gameNum}`
      };
    }

    // Get game type from schedule
    let checkinGameType = 'Regular';
    const checkinScheduleQuery = await db.collection('schedule')
      .where('date', '==', normalizedDate)
      .where('venue', '==', venue)
      .limit(1)
      .get();
    if (!checkinScheduleQuery.empty) {
      checkinGameType = checkinScheduleQuery.docs[0].data().type || 'Regular';
    }

    // Finalize-aware (2026-09-04). If this game has already been finalized,
    // a plain active checkin would sit unflagged forever: finalizeGame is what
    // sets attendanceOnly, and getLeaderboard only counts attendance rows that
    // carry it. So a late add through the kiosk, Director's Quick Check-In, or
    // Tonight earned nothing until someone re-finalized. Detect "finalized" by
    // the presence of processed eliminations for this game and flag the row
    // ourselves, unless this player already has a processed placement (their
    // placement bundles the attendance points; flagging would double-count).
    let lateAddFlags = {};
    const processedElims = await db.collection('eliminations')
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', '==', 'processed')
      .limit(1)
      .get();
    if (!processedElims.empty) {
      const ownPlacement = await db.collection('eliminations')
        .where('playerLower', '==', playerLower)
        .where('date', '==', normalizedDate)
        .where('gameNum', '==', parseInt(gameNum))
        .where('venue', '==', venue)
        .where('status', '==', 'processed')
        .limit(1)
        .get();
      lateAddFlags = ownPlacement.empty
        ? { attendanceOnly: true, lateAdd: true, processedAt: FieldValue.serverTimestamp() }
        : { attendanceOnly: false, lateAdd: true, processedAt: FieldValue.serverTimestamp() };
    }

    // Create check-in
    const checkinRef = await db.collection('checkins').add({
      player: player.trim(),
      playerLower: playerLower,
      date: normalizedDate,
      gameNum: parseInt(gameNum),
      venue: venue,
      gameType: checkinGameType,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      ...lateAddFlags
    });

    // Convert matching RSVP
    const matchingRsvps = await db.collection('rsvps')
      .where('playerLower', '==', playerLower)
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', '==', 'active')
      .get();

    const batch = db.batch();
    matchingRsvps.forEach(doc => {
      batch.update(doc.ref, { status: 'converted', convertedAt: FieldValue.serverTimestamp() });
    });
    await batch.commit();

    // Add player to master list if new
    const existingPlayer = await db.collection('players')
      .where('nameLower', '==', playerLower)
      .limit(1)
      .get();

    if (existingPlayer.empty) {
      await db.collection('players').add({
        name: player.trim(),
        nameLower: playerLower,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    return {
      status: 'success',
      message: lateAddFlags.attendanceOnly
        ? `${player} checked in for Game ${gameNum} (game already finalized; attendance points credited)`
        : `${player} checked in for Game ${gameNum}`,
      checkinId: checkinRef.id,
      rsvpsConverted: matchingRsvps.size,
      lateAdd: !!lateAddFlags.lateAdd
    };

  } catch (error) {
    console.error('Checkin error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Remove a check-in (soft delete)
 */
exports.removeCheckin = onCall(async (request) => doRemoveCheckin(request.data || {}));
async function doRemoveCheckin(data) {
  const { player, date, gameNum, venue } = data;

  if (!player || !date || !gameNum) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();

  try {
    // Find and soft-delete the check-in in Firebase
    const checkinsQuery = await db.collection('checkins')
      .where('playerLower', '==', playerLower)
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('status', '==', 'active')
      .get();

    if (checkinsQuery.empty) {
      return { status: 'not_found', message: 'Check-in not found' };
    }

    const batch = db.batch();
    checkinsQuery.docs.forEach(doc => {
      batch.update(doc.ref, {
        status: 'removed',
        removedAt: FieldValue.serverTimestamp()
      });
    });
    await batch.commit();

    return {
      status: 'success',
      message: `${player} removed from Game ${gameNum}`
    };

  } catch (error) {
    console.error('Remove checkin error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Record or update bounty count for a player
 * - Upsert logic: update if exists, insert if new
 */
exports.recordBounty = onCall(async (request) => {
  await requireRole(request, ['staff']);
  return doRecordBounty(request.data || {});
});
async function doRecordBounty(data) {
  const { player, date, gameNum, venue, count } = data;

  if (!player || !date || !gameNum || !venue || count === undefined) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();
  const bountyCount = parseInt(count) || 0;

  try {
    // Check for existing bounty entry
    const existingBounty = await db.collection('bounties')
      .where('playerLower', '==', playerLower)
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', 'in', ['active', 'processed'])
      .limit(1)
      .get();

    if (!existingBounty.empty) {
      // Update existing
      const docRef = existingBounty.docs[0].ref;
      await docRef.update({
        count: bountyCount,
        updatedAt: FieldValue.serverTimestamp(),
        syncedToGAS: false
      });

      return {
        status: 'success',
        message: 'Bounty updated',
        bountyId: docRef.id,
        isUpdate: true
      };
    }

    // Create new bounty
    const bountyRef = await db.collection('bounties').add({
      player: player.trim(),
      playerLower: playerLower,
      date: normalizedDate,
      gameNum: parseInt(gameNum),
      venue: venue,
      count: bountyCount,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      syncedToGAS: false
    });

    return {
      status: 'success',
      message: 'Bounty recorded',
      bountyId: bountyRef.id,
      isUpdate: false
    };

  } catch (error) {
    console.error('Record bounty error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Record a player elimination
 * - Duplicate detection
 * - Stores raw rank (points calculated during finalize)
 */
exports.recordElimination = onCall(async (request) => {
  await requireRole(request, ['staff']);
  return doRecordElimination(request.data || {});
});
async function doRecordElimination(data) {
  const { player, date, gameNum, venue, rank, overwrite } = data;

  if (!player || !date || !gameNum || !venue || !rank) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();
  const rankNum = parseInt(rank);

  try {
    // Check for existing elimination
    const existingElim = await db.collection('eliminations')
      .where('playerLower', '==', playerLower)
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', 'in', ['active', 'processed'])
      .limit(1)
      .get();

    if (!existingElim.empty) {
      // If overwrite mode, update the existing record
      if (overwrite) {
        const existingDoc = existingElim.docs[0];
        await existingDoc.ref.update({
          rank: rankNum,
          bonusPoints: null, // Recalculate during finalize
          status: 'active', // Reset to active so it can be reprocessed
          syncedToGAS: false,
          updatedAt: FieldValue.serverTimestamp()
        });
        return {
          status: 'updated',
          message: `${player} elimination updated to rank ${rankNum}`,
          eliminationId: existingDoc.id
        };
      }
      return {
        status: 'duplicate',
        message: `${player} is already eliminated`
      };
    }

    // Get game type from schedule
    let gameType = 'Regular';
    const scheduleQuery = await db.collection('schedule')
      .where('date', '==', normalizedDate)
      .where('venue', '==', venue)
      .limit(1)
      .get();

    if (!scheduleQuery.empty) {
      gameType = scheduleQuery.docs[0].data().type || 'Regular';
    }

    // Create elimination
    const elimRef = await db.collection('eliminations').add({
      player: player.trim(),
      playerLower: playerLower,
      date: normalizedDate,
      gameNum: parseInt(gameNum),
      venue: venue,
      rank: rankNum,
      bonusPoints: null, // Calculated during finalize
      gameType: gameType,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      syncedToGAS: false
    });

    return {
      status: 'success',
      message: `${player} eliminated at rank ${rankNum}`,
      eliminationId: elimRef.id
    };

  } catch (error) {
    console.error('Record elimination error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Undo a bounty or elimination entry (soft delete)
 */
exports.undoScoring = onCall(async (request) => {
  await requireRole(request, ['staff']);
  return doUndoScoring(request.data || {});
});
async function doUndoScoring(data) {
  const { entryId, type } = data;

  if (!entryId || !type) {
    throw new HttpsError('invalid-argument', 'Missing entryId or type');
  }

  const collection = type === 'bounty' ? 'bounties' : 'eliminations';

  try {
    const docRef = db.collection(collection).doc(entryId);
    const doc = await docRef.get();

    if (!doc.exists) {
      return { status: 'not_found', message: 'Entry not found' };
    }

    if (doc.data().status === 'removed') {
      return { status: 'already_removed', message: 'Entry already removed' };
    }

    await docRef.update({
      status: 'removed',
      removedAt: FieldValue.serverTimestamp(),
      syncedToGAS: false
    });

    return { status: 'success', message: 'Entry removed' };

  } catch (error) {
    console.error('Undo scoring error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Finalize a game - calculate tie-adjusted points and mark as processed
 */
exports.finalizeGame = onCall(async (request) => {
  await requireRole(request, ['staff']);
  return doFinalizeGame(request.data || {}, request.auth?.uid || null);
});
// Body of finalizeGame. `finalizedBy` is the acting uid for the submission
// audit. Other server features can call this after a placement correction on
// a finalized game (reset with doReFinalizeGame first).
async function doFinalizeGame(data, finalizedBy) {
  const { date, gameNum, venue } = data;

  if (!date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);

  try {
    // Load the three raw collections this game touches. Shared with
    // previewGameSubmission via loadGameRecords() so the pre-submit preview
    // can never disagree with what finalize actually sees.
    const { elimsSnap: elimsQuery, bountiesSnap: bountiesQuery, checkinsSnap: checkinsQuery } =
      await loadGameRecords(normalizedDate, gameNum, venue);

    if (elimsQuery.empty) {
      return { status: 'error', message: 'No active eliminations found for this game' };
    }

    // Derive gameType from the elimination records (set by director at entry time)
    const gameType = elimsQuery.docs[0].data().gameType || 'Regular';

    // Group by rank to detect ties
    const byRank = {};
    elimsQuery.docs.forEach(doc => {
      const rank = doc.data().rank;
      if (!byRank[rank]) byRank[rank] = [];
      byRank[rank].push(doc);
    });

    // Calculate points and update each elimination
    const batch = db.batch();
    const tieAdjustments = [];

    for (const [rank, docs] of Object.entries(byRank)) {
      const numTied = docs.length;
      const bonusPoints = calculateTiePoints(parseInt(rank), numTied);

      docs.forEach(doc => {
        const d = doc.data();
        batch.update(doc.ref, {
          bonusPoints: bonusPoints,
          numTied: numTied,
          status: 'processed',
          processedAt: FieldValue.serverTimestamp(),
          syncedToGAS: false
        });

        tieAdjustments.push({
          docId: doc.id,
          player: d.player,
          playerLower: d.playerLower || d.player.toLowerCase(),
          rank: parseInt(rank),
          bonusPoints: bonusPoints,
          numTied: numTied
        });
      });
    }

    // Process bounties too (loaded above via loadGameRecords)
    bountiesQuery.docs.forEach(doc => {
      batch.update(doc.ref, {
        status: 'processed',
        processedAt: FieldValue.serverTimestamp(),
        syncedToGAS: false
      });
    });

    // Get players who have eliminations (top 10 finishers)
    const eliminatedPlayers = new Set(
      elimsQuery.docs.map(doc => doc.data().playerLower || doc.data().player.toLowerCase())
    );

    // Checkins for this game were loaded above via loadGameRecords.
    // Mark checkins for non-eliminated players as attendanceOnly.
    // CRITICAL: explicitly clear the flag for placed players so we never
    // double-count (elimination points already bundle ATTENDANCE_POINTS).
    let attendanceOnlyCount = 0;
    checkinsQuery.docs.forEach(doc => {
      const data = doc.data();
      if (data.status === 'removed') return;

      const playerLower = data.playerLower || data.player.toLowerCase();
      if (!eliminatedPlayers.has(playerLower)) {
        // This player checked in but didn't place in top 10
        batch.update(doc.ref, {
          attendanceOnly: true,
          processedAt: FieldValue.serverTimestamp()
        });
        attendanceOnlyCount++;
      } else if (data.attendanceOnly === true) {
        // Placed player still flagged as attendance-only — clear it so
        // getLeaderboard doesn't add a second attendance bundle.
        batch.update(doc.ref, {
          attendanceOnly: false,
          processedAt: FieldValue.serverTimestamp()
        });
      }
    });

    await batch.commit();

    console.log(`Finalized: ${elimsQuery.size} elims, ${bountiesQuery.size} bounties, ${attendanceOnlyCount} attendance-only`);

    // ── submissionAudits (verdict trace, additive/non-blocking) ──────────────
    // Records a server-authoritative reconciliation verdict for this finalize so
    // partial/complete/unverified submissions are auditable later. Recomputed
    // server-side from the same snapshots finalize used — never trusts the client
    // for the verdict; only previewRan/overrideAcknowledged are client-supplied
    // process metadata. Failure here never affects the finalize response.
    try {
      let auditSeason = null;
      try { auditSeason = await resolveSeasonForDate(venue, normalizedDate); } catch (e) { auditSeason = null; }
      const rsvpsSnap = await loadRsvpsForGame(normalizedDate, venue);
      const report = buildSubmissionReport(
        { elimsSnap: elimsQuery, bountiesSnap: bountiesQuery, checkinsSnap: checkinsQuery, rsvpsSnap },
        { gameNum, season: auditSeason }
      );
      const meta = (data && data.submissionMeta) || {};
      const previewRan = meta.previewRan !== false;
      const reviewState = !previewRan
        ? 'unverified'
        : (report.verdict === 'PARTIAL' ? 'partial'
          : report.verdict === 'FULL' ? 'complete'
            : report.verdict.toLowerCase());
      await db.collection('submissionAudits').add({
        date: normalizedDate,
        gameNum: parseInt(gameNum),
        venue,
        gameType: report.gameType,
        verdict: report.verdict,
        reviewState,
        previewRan,
        overrideAcknowledged: meta.overrideAcknowledged === true,
        clientVerdict: meta.clientVerdict || null,
        counts: report.counts,
        warningIds: report.warnings.map(w => w.id),
        season: report.season ? report.season.number : null,
        finalizedBy: finalizedBy || null,
        createdAt: FieldValue.serverTimestamp()
      });
      console.log(`submissionAudit: ${reviewState} (${report.verdict}) for ${normalizedDate} G${gameNum}`);
    } catch (err) {
      console.error(`submissionAudit write failed: ${err.message}`);
    }

    // --- High Hand Automated Calculation ---
    // The pot is a LIVE display value for the season in progress, so only a
    // game belonging to the CURRENT season may move it. Back-finalizing a game
    // from a closed season used to recompute that season's total and write it
    // straight over the live figure — submitting Tight End 7/7/2026 G1 seven
    // weeks late reset the season-29 pot to season 28's $120.
    try {
      const season = await resolveSeasonForDate(venue, normalizedDate);
      const liveSeason = await resolveSeasonForDate(venue, appTodayStr());
      if (season && liveSeason && season.id === liveSeason.id) {
        await updateHighHandPotForSeason(venue, season);
      } else if (season) {
        console.log(
          `High Hand: pot recalc skipped — ${normalizedDate} is season ` +
          `${season.seasonNumber ?? season.id}, live season is ` +
          `${liveSeason ? (liveSeason.seasonNumber ?? liveSeason.id) : 'none'}.`
        );
      }
    } catch (err) {
      console.error(`High Hand calculation failed for ${venue}:`, err.message);
    }

    return {
      status: 'success',
      message: `Game finalized: ${elimsQuery.size} elims, ${bountiesQuery.size} bounties`,
      eliminations: elimsQuery.size,
      bounties: bountiesQuery.size,
      attendanceOnly: attendanceOnlyCount,
      tieAdjustments: tieAdjustments
    };

  } catch (error) {
    console.error('Finalize game error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Read-only reconciliation preview for a game BEFORE finalizing.
 * Runs the exact same queries finalizeGame uses (via loadGameRecords) but
 * commits nothing, and returns a FULL/PARTIAL/BLOCK verdict + counts +
 * per-player placements + warnings. Staff-gated like finalizeGame — this is a
 * director-only pre-finalize action and must never leak game data to non-staff.
 */
exports.previewGameSubmission = onCall(async (request) => {
  await requireRole(request, ['staff']);
  const { date, gameNum, venue } = request.data || {};

  if (!date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);

  try {
    const { elimsSnap, bountiesSnap, checkinsSnap } =
      await loadGameRecords(normalizedDate, gameNum, venue, { includeProcessed: true });
    const rsvpsSnap = await loadRsvpsForGame(normalizedDate, venue);

    let season = null;
    try { season = await resolveSeasonForDate(venue, normalizedDate); } catch (e) { season = null; }

    const report = buildSubmissionReport(
      { elimsSnap, bountiesSnap, checkinsSnap, rsvpsSnap },
      { gameNum, season }
    );

    return {
      status: 'success',
      date: normalizedDate,
      gameNum: parseInt(gameNum),
      venue,
      ...report
    };
  } catch (error) {
    console.error('previewGameSubmission error:', error);
    throw new HttpsError('internal', error.message);
  }
});

// ===========================================
// CALLABLE FUNCTIONS - PHASE 2 (READ)
// ===========================================

/**
 * Get daily stats (check-ins and RSVPs)
 * Reads from Firebase (source of truth)
 */
exports.getDailyStats = onCall(async (request) => {
  const { date, venue } = request.data;

  if (!date) {
    throw new HttpsError('invalid-argument', 'Missing date');
  }

  const normalizedDate = normalizeDate(date);

  try {
    // Build base queries
    let checkinsQuery = db.collection('checkins')
      .where('date', '==', normalizedDate)
      .where('status', '==', 'active');

    let rsvpsQuery = db.collection('rsvps')
      .where('date', '==', normalizedDate)
      .where('status', '==', 'active');

    if (venue) {
      checkinsQuery = checkinsQuery.where('venue', '==', venue);
      rsvpsQuery = rsvpsQuery.where('venue', '==', venue);
    }

    const [checkinsSnapshot, rsvpsSnapshot] = await Promise.all([
      checkinsQuery.get(),
      rsvpsQuery.get()
    ]);

    // Order check-ins newest-first so the kiosk lists the most recent sign-in
    // at the top (a discreet name reminder for staff). createdAt is a server
    // Timestamp; tolerate legacy docs that predate it (sort them oldest).
    const checkinMillis = (d) => {
      const ts = d.data().createdAt;
      if (!ts) return 0;
      if (typeof ts.toMillis === 'function') return ts.toMillis();
      if (typeof ts._seconds === 'number') return ts._seconds * 1000;
      if (typeof ts.seconds === 'number') return ts.seconds * 1000;
      return 0;
    };
    const orderedCheckinDocs = checkinsSnapshot.docs
      .slice()
      .sort((a, b) => checkinMillis(b) - checkinMillis(a));

    // Process Game 1 data
    const game1Checkins = orderedCheckinDocs
      .filter(doc => doc.data().gameNum === 1)
      .map(doc => doc.data().player);

    const game1Rsvps = rsvpsSnapshot.docs
      .filter(doc => doc.data().gameNum === 1)
      .map(doc => doc.data().player);

    // Process Game 2 data
    const game2Checkins = orderedCheckinDocs
      .filter(doc => doc.data().gameNum === 2)
      .map(doc => doc.data().player);

    const game2Rsvps = rsvpsSnapshot.docs
      .filter(doc => doc.data().gameNum === 2)
      .map(doc => doc.data().player);

    // Calculate pending RSVPs (not yet checked in)
    const game1CheckedInLower = game1Checkins.map(p => p.toLowerCase());
    const game1RsvpList = game1Rsvps.map(p => ({
      name: p,
      arrived: game1CheckedInLower.includes(p.toLowerCase())
    }));
    const game1PendingCount = game1RsvpList.filter(r => !r.arrived).length;

    const game2CheckedInLower = game2Checkins.map(p => p.toLowerCase());
    const game2RsvpList = game2Rsvps.map(p => ({
      name: p,
      arrived: game2CheckedInLower.includes(p.toLowerCase())
    }));
    const game2PendingCount = game2RsvpList.filter(r => !r.arrived).length;

    // Also return checkedIn as objects for consistency
    const game1CheckedInList = game1Checkins.map(p => ({ name: p }));
    const game2CheckedInList = game2Checkins.map(p => ({ name: p }));

    return {
      game1: {
        checkedIn: game1CheckedInList,
        rsvpList: game1RsvpList,
        checkedInCount: game1Checkins.length,
        rsvpPending: game1PendingCount,
        totalExpected: game1Checkins.length + game1PendingCount
      },
      game2: {
        checkedIn: game2CheckedInList,
        rsvpList: game2RsvpList,
        checkedInCount: game2Checkins.length,
        rsvpPending: game2PendingCount,
        totalExpected: game2Checkins.length + game2PendingCount
      }
    };

  } catch (error) {
    console.error('Get daily stats error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Get live scoring data for a game
 */
exports.getLiveScoring = onCall(async (request) => {
  const { date, gameNum, venue } = request.data;

  if (!date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);

  try {
    // Get bounties (include both active and processed for device handoff)
    const bountiesQuery = await db.collection('bounties')
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', 'in', ['active', 'processed'])
      .get();

    const bounties = bountiesQuery.docs.map(doc => ({
      player: doc.data().player,
      count: doc.data().count,
      entryId: doc.id
    }));

    // Get eliminations (include both active and processed for device handoff)
    const elimsQuery = await db.collection('eliminations')
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', 'in', ['active', 'processed'])
      .get();

    const eliminations = elimsQuery.docs.map(doc => ({
      player: doc.data().player,
      rank: doc.data().rank,
      entryId: doc.id
    }));

    return { bounties, eliminations };

  } catch (error) {
    console.error('Get live scoring error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Get player list for autocomplete
 * Reads from Firebase (source of truth)
 */
exports.getPlayerList = onCall(async (request) => {
  try {
    const playersSnapshot = await db.collection('players')
      .orderBy('name')
      .get();

    const players = playersSnapshot.docs.map(doc => doc.data().name);

    return { players: players || [] };

  } catch (error) {
    console.error('Get player list error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Set search aliases for a player (admin only).
 *
 * Aliases let one person be found by multiple names in autocomplete —
 * e.g. "TBG", "John Wallace", and "Jonathan" all resolve to the same
 * player — WITHOUT merging/destroying their canonical record (which is
 * what mergePlayers does). The canonical `name` is unchanged; aliases are
 * an additive, searchable layer.
 */
exports.setPlayerAliases = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { name, aliases } = request.data;

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new HttpsError('invalid-argument', 'Player name is required.');
  }

  const cleanAliases = Array.isArray(aliases)
    ? [...new Set(aliases.map(a => String(a || '').trim()).filter(Boolean))]
    : [];

  const snap = await db.collection('players')
    .where('nameLower', '==', name.trim().toLowerCase())
    .limit(1)
    .get();

  if (snap.empty) {
    throw new HttpsError('not-found', `Player "${name.trim()}" not found.`);
  }

  await snap.docs[0].ref.update({
    aliases: cleanAliases,
    aliasesLower: cleanAliases.map(a => a.toLowerCase())
  });

  return { status: 'success', name: name.trim(), aliases: cleanAliases };
});

/**
 * Add a new player to the players collection
 * Rejects if a player with the same name already exists (case-insensitive)
 */
exports.addPlayer = onCall(async (request) => {
  // Ungated on purpose (restored 2026-09-04). This backs the player app's
  // "Not on the list? Add yourself" button. It was ungated from 2026-03-31,
  // then swept into the admin bucket by the 2026-04-22 hardening pass; every
  // call since then failed (23/23 in Aug 2026 were 401/403). checkin and rsvp
  // both create roster entries without auth, so this matches them. Name is
  // validated and de-duplicated below.
  const { name } = request.data;
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new HttpsError('invalid-argument', 'Player name is required.');
  }
  const trimmed = name.trim();

  // Check for existing player (case-insensitive)
  const existing = await db.collection('players')
    .where('nameLower', '==', trimmed.toLowerCase())
    .limit(1)
    .get();

  if (!existing.empty) {
    throw new HttpsError('already-exists', `"${trimmed}" is already in the player list.`);
  }

  const ref = await db.collection('players').add({
    name: trimmed,
    nameLower: trimmed.toLowerCase(),
    createdAt: new Date().toISOString(),
    addedVia: 'self-service'
  });

  return { id: ref.id, name: trimmed };
});

/**
 * Find potential duplicate players using fuzzy matching
 * Returns groups of similar player names
 */
exports.findDuplicatePlayers = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { threshold = 80 } = request.data || {};

  try {
    const playersSnapshot = await db.collection('players')
      .orderBy('name')
      .get();

    const players = playersSnapshot.docs.map(doc => ({
      id: doc.id,
      name: doc.data().name,
      nameLower: doc.data().nameLower
    }));

    const playerNames = players.map(p => p.name);
    const processed = new Set();
    const duplicateGroups = [];

    for (const player of players) {
      if (processed.has(player.nameLower)) continue;

      const similar = findSimilarNames(player.name, playerNames, threshold / 100);
      if (similar.length > 0) {
        const group = [{ id: player.id, name: player.name, similarity: 100 }];

        for (const match of similar) {
          const matchPlayer = players.find(p => p.name === match.name);
          if (matchPlayer && !processed.has(matchPlayer.nameLower)) {
            group.push({ id: matchPlayer.id, name: match.name, similarity: match.similarity });
            processed.add(matchPlayer.nameLower);
          }
        }

        if (group.length > 1) {
          duplicateGroups.push(group);
        }
      }
      processed.add(player.nameLower);
    }

    return { duplicateGroups, totalPlayers: players.length };

  } catch (error) {
    console.error('Find duplicates error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Merge duplicate players - updates all references to use the canonical name
 */
exports.mergePlayers = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { canonicalName, duplicateIds } = request.data;

  if (!canonicalName || !duplicateIds || !Array.isArray(duplicateIds)) {
    throw new HttpsError('invalid-argument', 'Missing canonicalName or duplicateIds');
  }

  const canonicalLower = canonicalName.trim().toLowerCase();
  const batch = db.batch();
  let updatedCount = 0;

  try {
    // Get all players to merge and collect old names for GAS sync
    const playersToMerge = [];
    const oldNames = [];

    for (const entry of duplicateIds) {
      // Accept either a Firestore document ID or a player name.
      // The admin UI sends names, so resolve names to docs via nameLower.
      let doc = await db.collection('players').doc(entry).get();
      if (!doc.exists) {
        const byName = await db.collection('players')
          .where('nameLower', '==', String(entry).trim().toLowerCase())
          .limit(1)
          .get();
        if (!byName.empty) doc = byName.docs[0];
      }
      if (doc.exists) {
        const playerData = doc.data();
        playersToMerge.push({ id: doc.id, ...playerData });
        // Collect old name if different from canonical
        if (playerData.name && playerData.name.toLowerCase() !== canonicalLower) {
          oldNames.push(playerData.name);
        }
      }
    }

    // Fail loudly instead of silently "succeeding" with 0 merges.
    if (playersToMerge.length === 0) {
      throw new HttpsError('not-found',
        `No matching player found for: ${duplicateIds.join(', ')}`);
    }

    // Update all checkins, eliminations, bounties, rsvps for each duplicate
    for (const player of playersToMerge) {
      const oldNameLower = player.nameLower || (player.name || '').trim().toLowerCase();

      // Skip if it's already the canonical name
      if (oldNameLower === canonicalLower) continue;

      // Update checkins
      const checkins = await db.collection('checkins')
        .where('playerLower', '==', oldNameLower)
        .get();
      checkins.docs.forEach(doc => {
        batch.update(doc.ref, {
          player: canonicalName.trim(),
          playerLower: canonicalLower
        });
        updatedCount++;
      });

      // Update eliminations
      const elims = await db.collection('eliminations')
        .where('playerLower', '==', oldNameLower)
        .get();
      elims.docs.forEach(doc => {
        batch.update(doc.ref, {
          player: canonicalName.trim(),
          playerLower: canonicalLower
        });
        updatedCount++;
      });

      // Update bounties
      const bounties = await db.collection('bounties')
        .where('playerLower', '==', oldNameLower)
        .get();
      bounties.docs.forEach(doc => {
        batch.update(doc.ref, {
          player: canonicalName.trim(),
          playerLower: canonicalLower
        });
        updatedCount++;
      });

      // Update RSVPs
      const rsvps = await db.collection('rsvps')
        .where('playerLower', '==', oldNameLower)
        .get();
      rsvps.docs.forEach(doc => {
        batch.update(doc.ref, {
          player: canonicalName.trim(),
          playerLower: canonicalLower
        });
        updatedCount++;
      });

      // Delete the duplicate player entry
      batch.delete(db.collection('players').doc(player.id));
    }

    // Ensure canonical player exists
    const canonicalExists = await db.collection('players')
      .where('nameLower', '==', canonicalLower)
      .limit(1)
      .get();

    if (canonicalExists.empty) {
      const newPlayerRef = db.collection('players').doc();
      batch.set(newPlayerRef, {
        name: canonicalName.trim(),
        nameLower: canonicalLower,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    await batch.commit();

    return {
      status: 'success',
      message: `Merged ${playersToMerge.length} players into "${canonicalName}"`,
      updatedRecords: updatedCount,
      oldNames: oldNames
    };

  } catch (error) {
    console.error('Merge players error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Delete a player from the master list
 * Only deletes if player has no associated records
 */
exports.deletePlayer = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { playerId, force = false } = request.data;

  if (!playerId) {
    throw new HttpsError('invalid-argument', 'Missing playerId');
  }

  try {
    const playerDoc = await db.collection('players').doc(playerId).get();
    if (!playerDoc.exists) {
      throw new HttpsError('not-found', 'Player not found');
    }

    const player = playerDoc.data();
    const playerLower = player.nameLower;

    // Check for associated records
    if (!force) {
      const hasCheckins = !(await db.collection('checkins')
        .where('playerLower', '==', playerLower).limit(1).get()).empty;
      const hasElims = !(await db.collection('eliminations')
        .where('playerLower', '==', playerLower).limit(1).get()).empty;
      const hasBounties = !(await db.collection('bounties')
        .where('playerLower', '==', playerLower).limit(1).get()).empty;

      if (hasCheckins || hasElims || hasBounties) {
        return {
          status: 'blocked',
          message: `Cannot delete "${player.name}" - has associated records. Use force=true to delete anyway.`,
          hasCheckins, hasElims, hasBounties
        };
      }
    }

    await db.collection('players').doc(playerId).delete();

    return {
      status: 'success',
      message: `Deleted player "${player.name}"`
    };

  } catch (error) {
    console.error('Delete player error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Get leaderboard standings
 */
// Body of getLeaderboard, callable internally (player-desk information
// requests read the same standings the Standings tab shows).
async function computeLeaderboard({ venue, seasonId } = {}) {
  if (!venue) {
    throw new HttpsError('invalid-argument', 'Missing venue');
  }

  try {
    // Season + effective window (endDate may be derived from the next season)
    const resolved = await resolveSeasonForVenue(venue, seasonId);
    const startDate = resolved.startDate;
    const endDate = resolved.endDate;
    const championshipDate = resolved.championshipDate;
    const seasonName = resolved.seasonName;
    const seasonNumber = resolved.seasonNumber;

    const seasonInfo = { venue, startDate, endDate, seasonNumber };

    // Big Stack / Championship nights, excluded by date regardless of window
    const nonSeasonDates = await loadNonSeasonDates(venue);

    // Query ALL eliminations for this venue (old data has no status field)
    let elimQuery = db.collection('eliminations')
      .where('venue', '==', venue);

    const elimsSnapshot = await elimQuery.get();

    // Aggregate stats by player
    const playerStats = {};
    const gameSet = new Set(); // Track unique games
    // Per-player set of gameKeys the player already received elimination points for.
    // Used later to prevent double-counting attendance-only points on the same game.
    const playerElimGameKeys = {};

    elimsSnapshot.docs.forEach(doc => {
      const data = doc.data();

      // Skip removed records
      if (data.status === 'removed') return;

      // Only Regular-season events score. Big Stack and Championship nights are
      // standalone and must never reach season standings — enforced by TYPE, not
      // by the date window, since a season's window can legitimately stay open
      // across those nights (see resolveSeasonEnd). Blank gameType = 'Regular',
      // matching the default applied at write time.
      if (!isSeasonEligibleGameType(data.gameType)) return;

      // Backstop: the schedule says this night wasn't a Regular season game.
      if (nonSeasonDates.has(dateKey(data.date))) return;

      // Date must be valid and inside the season window (rejects Invalid Date "from last" records).
      if (!isInSeasonWindow(data.date, startDate, endDate)) return;

      // If the record carries an explicit season number, enforce it.
      if (data.season !== undefined && data.season !== null
          && seasonNumber !== undefined && seasonNumber !== null
          && Number(data.season) !== Number(seasonNumber)) {
        return;
      }

      const player = data.player;
      if (!player) return; // Skip records without player name

      const gameKey = `${data.date}-${data.gameNum}`;
      // Key by normalized lower-case name to survive case/formatting mismatches.
      const pLower = data.playerLower || player.toLowerCase();
      if (!playerElimGameKeys[pLower]) playerElimGameKeys[pLower] = new Set();
      playerElimGameKeys[pLower].add(gameKey);

      if (!playerStats[player]) {
        playerStats[player] = {
          points: 0,
          bounties: 0,
          gamesPlayed: 0,
          wins: 0,
          games: new Set()
        };
      }

      // Data formats:
      // - Synced from GAS: rank=position, bonusPoints=bonus, totalPoints=total
      // - New from director: rank=position, bonusPoints=bonus (after finalize)
      // - Old imported: rank=total points (bonus+attendance included)
      let pointsToAdd = 0;
      let isWin = false;

      if (data.totalPoints !== undefined && data.totalPoints !== null) {
        // GAS synced format: use totalPoints directly (most accurate)
        pointsToAdd = data.totalPoints;
        isWin = (data.rank === 1);
      } else if (data.bonusPoints !== undefined && data.bonusPoints !== null) {
        // New format: bonusPoints has calculated bonus, add attendance separately
        pointsToAdd = data.bonusPoints + ATTENDANCE_POINTS;
        isWin = (data.rank === 1 || data.bonusPoints === 90);
      } else if (data.rank !== undefined && data.rank !== null) {
        // Old format: rank field might contain total points or position
        // If rank > 10, assume it's total points; otherwise calculate from position
        if (data.rank > 10) {
          pointsToAdd = data.rank; // Total points already included
          isWin = (data.rank >= 100);
        } else {
          pointsToAdd = (BONUS_POINTS[data.rank] || 0) + ATTENDANCE_POINTS;
          isWin = (data.rank === 1);
        }
      }

      playerStats[player].points += pointsToAdd;

      // Track games played
      if (!playerStats[player].games.has(gameKey)) {
        playerStats[player].games.add(gameKey);
        playerStats[player].gamesPlayed++;
      }

      // Track wins
      if (isWin) {
        playerStats[player].wins++;
      }
    });

    // Add bounties (query all - old data has no status field)
    // Deduplicate by player+date+gameNum to handle duplicate records
    const bountiesSnapshot = await db.collection('bounties')
      .where('venue', '==', venue)
      .get();

    const seenBounties = new Set(); // Track unique bounty entries
    bountiesSnapshot.docs.forEach(doc => {
      const data = doc.data();

      // Skip removed records
      if (data.status === 'removed') return;

      // Deduplicate by player+date+gameNum (prefer processed records)
      const bountyKey = `${(data.player || '').toLowerCase()}|${data.date}|${data.gameNum}`;
      if (seenBounties.has(bountyKey)) return; // Skip duplicate
      seenBounties.add(bountyKey);

      // Bounty records carry no gameType, so the schedule is the only signal
      // that this night was a Big Stack / Championship event.
      if (nonSeasonDates.has(dateKey(data.date))) return;

      // Date must be valid and inside the season window.
      if (!isInSeasonWindow(data.date, startDate, endDate)) return;

      // If the record carries an explicit season number, enforce it.
      if (data.season !== undefined && data.season !== null
          && seasonNumber !== undefined && seasonNumber !== null
          && Number(data.season) !== Number(seasonNumber)) {
        return;
      }

      const player = data.player;
      if (!player) return; // Skip records without player name

      // Create player entry if they only have bounties (no eliminations)
      if (!playerStats[player]) {
        playerStats[player] = {
          points: 0,
          bounties: 0,
          gamesPlayed: 0,
          wins: 0,
          games: new Set()
        };
      }
      playerStats[player].bounties += data.count || 0;
    });

    // Add attendance-only check-ins (played but didn't place in top 10)
    const checkinsSnapshot = await db.collection('checkins')
      .where('venue', '==', venue)
      .where('attendanceOnly', '==', true)
      .get();

    checkinsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const player = data.player;
      if (!player) return;

      const gameKey = `${data.date}-${data.gameNum}`;
      // Use normalized lower-case name to match the elimination dedupe map.
      const pLower = data.playerLower || player.toLowerCase();
      const hasElimForGame = !!(playerElimGameKeys[pLower] && playerElimGameKeys[pLower].has(gameKey));

      // Full business-rule eligibility check (venue, date window, season match,
      // status, gameType, and no double-count with eliminations).
      if (!isSeasonAttendanceEligible(data, seasonInfo, hasElimForGame)) return;

      if (!playerStats[player]) {
        playerStats[player] = {
          points: 0,
          bounties: 0,
          gamesPlayed: 0,
          wins: 0,
          games: new Set()
        };
      }

      // Add attendance points for this game
      playerStats[player].points += ATTENDANCE_POINTS;

      // Track games played
      if (!playerStats[player].games.has(gameKey)) {
        playerStats[player].games.add(gameKey);
        playerStats[player].gamesPlayed++;
      }
    });

    // ── Honored RSVPs — the tiebreaker after games played (the owner, 2026-09-05) ──
    // An RSVP is "honored" when the player RSVP'd and then actually played that
    // game. `checkin` flips a matching RSVP to status 'converted' at check-in
    // time; we count those, restricted to games that scored for this season and
    // to games the player is credited with above (so a converted RSVP on a night
    // whose results never got finalized does not count).
    const rsvpsHonored = {}; // playerLower -> count of DISTINCT games
    const honoredGames = {}; // playerLower -> Set(gameKey), so duplicate RSVP docs cannot double-count
    try {
      const convSnap = await db.collection('rsvps')
        .where('venue', '==', venue)
        .where('status', '==', 'converted')
        .get();
      const statsByLower = {};
      Object.entries(playerStats).forEach(([name, st]) => { statsByLower[name.toLowerCase()] = st; });
      convSnap.docs.forEach(doc => {
        const d = doc.data();
        if (!d.player || !d.date) return;
        if (nonSeasonDates.has(dateKey(d.date))) return;
        if (!isInSeasonWindow(d.date, startDate, endDate)) return;
        const pl = d.playerLower || String(d.player).toLowerCase();
        const st = statsByLower[pl];
        const gk = `${d.date}-${d.gameNum}`;
        if (!st || !st.games.has(gk)) return;
        if (!honoredGames[pl]) honoredGames[pl] = new Set();
        if (honoredGames[pl].has(gk)) return;
        honoredGames[pl].add(gk);
        rsvpsHonored[pl] = (rsvpsHonored[pl] || 0) + 1;
      });
    } catch (e) { console.warn('rsvpsHonored count failed (non-blocking):', e.message); }

    // Check for consolation winner qualification (carries over from previous season)
    // Supports 0, 1, or 2 winners stored as array; falls back gracefully if old string format
    let consolationWinners = [];
    try {
      const configDoc = await db.collection('config').doc('consolationWinners').get();
      if (configDoc.exists) {
        const rawVal = configDoc.data()[venue];
        if (Array.isArray(rawVal)) {
          consolationWinners = rawVal.filter(Boolean);
        } else if (rawVal) {
          consolationWinners = [rawVal]; // backwards compat: old string format
        }
      }
    } catch (e) { /* ignore - config may not exist yet */ }

    // Manual auto-qualifiers for this venue + season (Staff Portal → Auto-Qualifiers).
    // Stored in config/autoQualifiers as { [venue]: { [seasonNumber]: [{ name, note, ... }] } }.
    // Matched case-insensitively so a roster-spelling mismatch can't drop a berth.
    let autoQualifiers = [];
    if (seasonNumber !== undefined && seasonNumber !== null) {
      try {
        const aqDoc = await db.collection('config').doc('autoQualifiers').get();
        if (aqDoc.exists) {
          const list = (aqDoc.data()[venue] || {})[String(seasonNumber)];
          if (Array.isArray(list)) {
            autoQualifiers = list
              .map(e => (typeof e === 'string' ? e : e && e.name))
              .filter(Boolean);
          }
        }
      } catch (e) { /* ignore - config may not exist yet */ }
    }
    const autoQualLower = new Set(autoQualifiers.map(n => n.toLowerCase()));

    // Convert to array and sort
    const standings = Object.entries(playerStats)
      .map(([name, stats]) => ({
        name: name,  // Frontend expects 'name' not 'player'
        points: stats.points,
        bounties: stats.bounties,
        gamesPlayed: stats.gamesPlayed,
        rsvpsHonored: rsvpsHonored[name.toLowerCase()] || 0,
        wins: stats.wins,
        qualified: stats.wins > 0 || consolationWinners.includes(name) || autoQualLower.has(name.toLowerCase()),
        consolationQualified: consolationWinners.includes(name),
        autoQualified: autoQualLower.has(name.toLowerCase())
      }))
      .sort((a, b) => b.points - a.points || b.gamesPlayed - a.gamesPlayed || (b.rsvpsHonored || 0) - (a.rsvpsHonored || 0) || a.name.localeCompare(b.name));

    // If any consolation winner has no points this season, add them to standings
    consolationWinners.forEach(winner => {
      if (!standings.find(s => s.name === winner)) {
        standings.push({
          name: winner,
          points: 0,
          bounties: 0,
          gamesPlayed: 0,
          wins: 0,
          qualified: true,
          consolationQualified: true
        });
      }
    });
    if (consolationWinners.length > 0) {
      standings.sort((a, b) => b.points - a.points || b.gamesPlayed - a.gamesPlayed || (b.rsvpsHonored || 0) - (a.rsvpsHonored || 0) || a.name.localeCompare(b.name));
    }

    // Auto-qualifiers with no points this season still get a standings row (and the berth)
    autoQualifiers.forEach(winner => {
      if (!standings.find(s => s.name.toLowerCase() === winner.toLowerCase())) {
        standings.push({
          name: winner,
          points: 0,
          bounties: 0,
          gamesPlayed: 0,
          wins: 0,
          qualified: true,
          consolationQualified: false,
          autoQualified: true
        });
      }
    });
    if (autoQualifiers.length > 0) {
      standings.sort((a, b) => b.points - a.points || b.gamesPlayed - a.gamesPlayed || (b.rsvpsHonored || 0) - (a.rsvpsHonored || 0) || a.name.localeCompare(b.name));
    }

    // Add rank with tie detection (same points AND same gamesPlayed = tie)
    standings.forEach((s, i) => {
      if (i === 0) { s.rank = 1; }
      else {
        const prev = standings[i - 1];
        s.rank = (s.points === prev.points && s.gamesPlayed === prev.gamesPlayed
                  && (s.rsvpsHonored || 0) === (prev.rsvpsHonored || 0))
          ? prev.rank
          : i + 1;
      }
    });
    standings.forEach(s => {
      s.tied = standings.filter(o => o.rank === s.rank).length > 1;
    });

    return {
      status: 'success',
      venue,
      championshipDate,
      seasonName,
      standings
    };

  } catch (error) {
    console.error('Get leaderboard error:', error);
    throw new HttpsError('internal', error.message);
  }
}
exports.getLeaderboard = onCall(async (request) => computeLeaderboard(request.data || {}));

// ===========================================
// CALLABLE FUNCTIONS - RSVP
// ===========================================

/**
 * RSVP for a game
 * Writes to Firebase (source of truth)
 */
exports.rsvp = onCall(async (request) => {
  const { player, date, gameNum, venue, status: rsvpStatus } = request.data;

  if (!player || !date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();
  const games = gameNum === 'both' ? [1, 2] : [parseInt(gameNum)];
  const writeStatus = rsvpStatus === 'declined' ? 'declined' : 'active';

  const results = [];

  try {
    for (const gNum of games) {
      // Check for any existing RSVP (active or declined) and remove it first
      const existingRsvp = await db.collection('rsvps')
        .where('playerLower', '==', playerLower)
        .where('date', '==', normalizedDate)
        .where('gameNum', '==', gNum)
        .where('venue', '==', venue)
        .where('status', 'in', ['active', 'declined'])
        .limit(1)
        .get();

      if (!existingRsvp.empty) {
        const existing = existingRsvp.docs[0];
        if (existing.data().status === writeStatus) {
          results.push({ game: gNum, status: 'duplicate' });
          continue;
        }
        // Update existing to new status
        await existing.ref.update({ status: writeStatus });
        results.push({ game: gNum, status: 'success' });
        continue;
      }

      await db.collection('rsvps').add({
        player: player.trim(),
        playerLower: playerLower,
        date: normalizedDate,
        gameNum: gNum,
        venue: venue,
        status: writeStatus,
        createdAt: FieldValue.serverTimestamp(),
        syncedToGAS: false
      });

      results.push({ game: gNum, status: 'success' });
    }

    // Add player to master list if new
    const existingPlayer = await db.collection('players')
      .where('nameLower', '==', playerLower)
      .limit(1)
      .get();

    if (existingPlayer.empty) {
      await db.collection('players').add({
        name: player.trim(),
        nameLower: playerLower,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    const anySuccess = results.some(r => r.status === 'success');
    return {
      status: anySuccess ? 'success' : 'duplicate',
      message: anySuccess ? 'RSVP saved' : 'Already on the list',
      details: results
    };

  } catch (error) {
    console.error('RSVP error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Remove RSVP
 */
exports.removeRsvp = onCall(async (request) => {
  const { player, date, gameNum, venue } = request.data;

  if (!player || !date || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();
  const games = gameNum === 'both' ? [1, 2] : [parseInt(gameNum)];

  try {
    let removed = false;

    for (const gNum of games) {
      const rsvpsQuery = await db.collection('rsvps')
        .where('playerLower', '==', playerLower)
        .where('date', '==', normalizedDate)
        .where('gameNum', '==', gNum)
        .where('venue', '==', venue)
        .where('status', '==', 'active')
        .get();

      const batch = db.batch();
      rsvpsQuery.docs.forEach(doc => {
        batch.update(doc.ref, {
          status: 'removed',
          removedAt: FieldValue.serverTimestamp()
        });
        removed = true;
      });
      await batch.commit();
    }

    return {
      status: removed ? 'success' : 'not_found',
      message: removed ? 'RSVP removed' : 'RSVP not found'
    };

  } catch (error) {
    console.error('Remove RSVP error:', error);
    throw new HttpsError('internal', error.message);
  }
});

// ===========================================
// UTILITY ENDPOINTS
// ===========================================

/**
 * Health check
 */
exports.health = onRequest((req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    architecture: 'firebase-first'
  });
});

/**
 * Server clock for the synced venue timer (docs/timer-prd/07-synced-clock.md).
 * Every screen measures its offset from this so the TV and phones agree on
 * "now". Served same-origin through the /api/server-time hosting rewrite.
 * Ungated on purpose: it returns only the current time.
 */
exports.serverTime = onRequest((req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ now: Date.now() });
});

/**
 * Add attendance credit for a player who forgot to check in
 * Use this to retroactively give attendance points for past games
 */
exports.addAttendanceCredit = onCall(async (request) => {
  // Staff-level since 2026-09-03: this is the "give a player their 10" button
  // on the staff Tonight page. It only writes one attendance-only checkin row
  // (no account or personal data), and it is the one attendance path that is
  // safe AFTER a game is finalized — plain `checkin` leaves attendanceOnly
  // unset, so a late add via the kiosk/director earns nothing until re-finalize.
  await requireRole(request, ['staff', 'admin']);
  return doAddAttendanceCredit(request.data || {});
});
async function doAddAttendanceCredit(data) {
  const { player, date, gameNum, venue } = data;

  if (!player || !date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields: player, date, gameNum, venue');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();

  try {
    // Check if player already has a checkin for this game
    const existingCheckin = await db.collection('checkins')
      .where('playerLower', '==', playerLower)
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .limit(1)
      .get();

    if (!existingCheckin.empty) {
      const doc = existingCheckin.docs[0];
      const data = doc.data();
      if (data.status === 'removed') {
        // Restore removed checkin
        await doc.ref.update({
          status: 'checked-in',
          attendanceOnly: true,
          restoredAt: FieldValue.serverTimestamp()
        });
        return { status: 'restored', message: `Restored attendance credit for ${player}` };
      }
      return { status: 'exists', message: `${player} already has a checkin for this game` };
    }

    // Check if player has an elimination (top 10 finish) - they don't need attendance-only
    const existingElim = await db.collection('eliminations')
      .where('playerLower', '==', playerLower)
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', 'in', ['active', 'processed'])
      .limit(1)
      .get();

    if (!existingElim.empty) {
      return {
        status: 'not_needed',
        message: `${player} has a top 10 finish - already getting attendance points with their placement`
      };
    }

    // Create attendance-only checkin
    const checkinRef = await db.collection('checkins').add({
      player: player.trim(),
      playerLower: playerLower,
      date: normalizedDate,
      gameNum: parseInt(gameNum),
      venue: venue,
      status: 'checked-in',
      attendanceOnly: true,
      manuallyAdded: true,
      createdAt: FieldValue.serverTimestamp()
    });

    return {
      status: 'success',
      message: `Added 10 attendance points for ${player} (${normalizedDate} game ${gameNum})`,
      checkinId: checkinRef.id
    };

  } catch (error) {
    console.error('Add attendance credit error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Clean up duplicate bounty records
 * Keeps processed records, removes null status duplicates
 */
exports.cleanupDuplicateBounties = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { venue, dryRun } = request.data || {};

  try {
    let query = db.collection('bounties');
    if (venue) query = query.where('venue', '==', venue);

    const snapshot = await query.get();

    // Group by player+date+gameNum
    const bountyGroups = {};
    snapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.status === 'removed') return;

      const key = `${(data.player || '').toLowerCase()}|${data.date}|${data.gameNum}|${data.venue}`;
      if (!bountyGroups[key]) bountyGroups[key] = [];
      bountyGroups[key].push({ doc, data });
    });

    // Find duplicates and mark for removal
    const toDelete = [];
    for (const [key, entries] of Object.entries(bountyGroups)) {
      if (entries.length > 1) {
        // Sort: prefer processed > null status
        entries.sort((a, b) => {
          if (a.data.status === 'processed' && b.data.status !== 'processed') return -1;
          if (b.data.status === 'processed' && a.data.status !== 'processed') return 1;
          return 0;
        });

        // Keep first (preferred), delete rest
        for (let i = 1; i < entries.length; i++) {
          toDelete.push({
            id: entries[i].doc.id,
            player: entries[i].data.player,
            date: entries[i].data.date,
            gameNum: entries[i].data.gameNum,
            count: entries[i].data.count,
            status: entries[i].data.status
          });
        }
      }
    }

    if (!dryRun && toDelete.length > 0) {
      const batch = db.batch();
      for (const item of toDelete) {
        const ref = db.collection('bounties').doc(item.id);
        batch.update(ref, { status: 'removed', removedReason: 'duplicate' });
      }
      await batch.commit();
    }

    return {
      status: 'success',
      dryRun: dryRun || false,
      duplicatesFound: toDelete.length,
      duplicates: toDelete
    };
  } catch (error) {
    console.error('Cleanup bounties error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Diagnostic function to inspect game data
 */
exports.inspectGameData = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { date, gameNum, venue, player } = request.data || {};
  const normalizedDate = date ? normalizeDate(date) : null;

  try {
    const results = {
      eliminations: [],
      bounties: [],
      checkins: []
    };

    // Query eliminations
    let elimQuery = db.collection('eliminations');
    if (venue) elimQuery = elimQuery.where('venue', '==', venue);
    if (normalizedDate) elimQuery = elimQuery.where('date', '==', normalizedDate);
    if (gameNum) elimQuery = elimQuery.where('gameNum', '==', parseInt(gameNum));

    const elimDocs = await elimQuery.get();
    elimDocs.docs.forEach(doc => {
      const data = doc.data();
      if (player && data.player.toLowerCase() !== player.toLowerCase()) return;
      results.eliminations.push({
        id: doc.id,
        player: data.player,
        date: data.date,
        gameNum: data.gameNum,
        rank: data.rank,
        bonusPoints: data.bonusPoints,
        status: data.status,
        syncedToGAS: data.syncedToGAS
      });
    });

    // Query bounties
    let bountyQuery = db.collection('bounties');
    if (venue) bountyQuery = bountyQuery.where('venue', '==', venue);
    if (normalizedDate) bountyQuery = bountyQuery.where('date', '==', normalizedDate);
    if (gameNum) bountyQuery = bountyQuery.where('gameNum', '==', parseInt(gameNum));

    const bountyDocs = await bountyQuery.get();
    bountyDocs.docs.forEach(doc => {
      const data = doc.data();
      if (player && data.player.toLowerCase() !== player.toLowerCase()) return;
      results.bounties.push({
        id: doc.id,
        player: data.player,
        date: data.date,
        gameNum: data.gameNum,
        count: data.count,
        status: data.status,
        syncedToGAS: data.syncedToGAS
      });
    });

    // Query checkins
    let checkinQuery = db.collection('checkins');
    if (venue) checkinQuery = checkinQuery.where('venue', '==', venue);
    if (normalizedDate) checkinQuery = checkinQuery.where('date', '==', normalizedDate);
    if (gameNum) checkinQuery = checkinQuery.where('gameNum', '==', parseInt(gameNum));

    const checkinDocs = await checkinQuery.get();
    checkinDocs.docs.forEach(doc => {
      const data = doc.data();
      if (player && data.player.toLowerCase() !== player.toLowerCase()) return;
      results.checkins.push({
        id: doc.id,
        player: data.player,
        date: data.date,
        gameNum: data.gameNum,
        status: data.status,
        attendanceOnly: data.attendanceOnly
      });
    });

    return {
      status: 'success',
      counts: {
        eliminations: results.eliminations.length,
        bounties: results.bounties.length,
        checkins: results.checkins.length
      },
      ...results
    };
  } catch (error) {
    console.error('Inspect game data error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Re-finalize a game (reset status and finalize again)
 */
exports.reFinalizeGame = onCall(async (request) => {
  await requireRole(request, ['admin']);
  return doReFinalizeGame(request.data || {});
});
async function doReFinalizeGame(data) {
  const { date, gameNum, venue } = data;

  if (!date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);

  try {
    // Reset processed eliminations back to active
    const elimsQuery = await db.collection('eliminations')
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', '==', 'processed')
      .get();

    const batch = db.batch();
    let resetCount = 0;

    elimsQuery.docs.forEach(doc => {
      batch.update(doc.ref, {
        status: 'active',
        bonusPoints: null,
        syncedToGAS: false
      });
      resetCount++;
    });

    // Reset processed bounties back to active
    const bountiesQuery = await db.collection('bounties')
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', parseInt(gameNum))
      .where('venue', '==', venue)
      .where('status', '==', 'processed')
      .get();

    bountiesQuery.docs.forEach(doc => {
      batch.update(doc.ref, {
        status: 'active',
        syncedToGAS: false
      });
      resetCount++;
    });

    await batch.commit();

    return {
      status: 'success',
      message: `Reset ${resetCount} records to active status. Now call finalizeGame to re-process.`,
      eliminationsReset: elimsQuery.size,
      bountiesReset: bountiesQuery.size
    };
  } catch (error) {
    console.error('Re-finalize error:', error);
    throw new HttpsError('internal', error.message);
  }
}

/**
 * Save a manual championship director override (which section a player is in)
 */
exports.saveChampOverride = onCall(async (request) => {
    await requireRole(request, ['staff']);
    const { venue, date, gameNum, player, section } = request.data;
  if (!venue || !date || !gameNum || !player || !section) {
    throw new HttpsError('invalid-argument', 'Missing required fields.');
  }
  const docId = (venue + '_' + date).replace(/[\s\/]/g, '_');
  const fieldKey = `g${gameNum}_${player.toLowerCase()}`;
  await db.collection('champ_overrides').doc(docId).set(
    { [fieldKey]: section, venue, date, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { status: 'ok' };
});

/**
 * Get all manual championship director overrides for a venue+date
 * Returns { overrides: { 1: { "player name lower": "playing"|"ondeck"|"consolation" }, 2: {...} } }
 */
exports.getChampOverrides = onCall(async (request) => {
    await requireRole(request, ['staff']);
    const { venue, date } = request.data || {};
  if (!venue || !date) return { overrides: { 1: {}, 2: {} } };
  const docId = (venue + '_' + date).replace(/[\s\/]/g, '_');
  const docSnap = await db.collection('champ_overrides').doc(docId).get();
  if (!docSnap.exists) return { overrides: { 1: {}, 2: {} } };
  const data = docSnap.data();
  const overrides = { 1: {}, 2: {} };
  Object.entries(data).forEach(([key, val]) => {
    if (typeof val !== 'string') return;
    const m = key.match(/^g(\d)_(.+)$/);
    if (m) overrides[parseInt(m[1])][m[2]] = val;
  });
  return { overrides };
});

/**
 * Returns rank-1 (winner) records for past games
 * Returns a map: { "YYYY-MM-DD_gameNum": "Player Name", ... }
 */
exports.getWinners = onCall(async (request) => {
  try {
    const snap = await db.collection('eliminations')
      .where('rank', '==', 1)
      .get();

    const winners = {};
    snap.forEach(doc => {
      const d = doc.data();
      if (d.date && d.player && d.status !== 'removed') {
        // Dates stored as M/D/YYYY — convert to YYYY-MM-DD for the calendar
        let ymd = d.date;
        if (d.date.includes('/')) {
          const parts = d.date.split('/');
          ymd = `${parts[2]}-${String(parts[0]).padStart(2,'0')}-${String(parts[1]).padStart(2,'0')}`;
        }
        const key = ymd + '_' + (d.gameNum || 1);
        winners[key] = d.player;
      }
    });
    return { winners };
  } catch (err) {
    throw new HttpsError('internal', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GAS schedule sync RETIRED (2026-05-30).
// The `schedule` collection is now authored natively in Firestore via
// saveScheduleEntry / deleteScheduleEntry (admin/schedule.html) and read by
// getSchedule below. The old GAS->Firestore mirror (performScheduleSync, the
// every-8h CRON scheduledSyncScheduleCache, and adminSyncScheduleCache) was
// removed here. To restore it, see git tag `pre-schedule-migration`.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Save a schedule entry (date / venue / type / theme) directly to the native
 * Firestore `schedule` collection — the authoring path that replaces typing
 * rows into the Google Sheet. As of the 2026-05-30 cutover this collection is
 * the source of truth; getSchedule reads from it directly.
 *
 * Keyed by normalizeEventKey(date, venue) — the SAME doc id scheme as
 * eventContent, so schedule and content entries line up across collections.
 */
exports.saveScheduleEntry = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { date, venue, type, theme, gearDescription, announcementNote, originalDate, originalVenue } = request.data || {};
  if (!date || !venue) {
    throw new HttpsError('invalid-argument', 'date and venue are required');
  }

  // `type` drives season eligibility + Big Stack exclusion, so it must be a
  // known value. Reject unknowns rather than silently mis-scoring a game.
  const safeType = type || 'Regular';
  if (!VALID_SCHEDULE_TYPES.has(safeType)) {
    throw new HttpsError(
      'invalid-argument',
      `Invalid type "${type}". Must be one of: ${[...VALID_SCHEDULE_TYPES].join(', ')}`
    );
  }

  const key = normalizeEventKey(date, venue);

  // MOVE: if the caller is editing an existing event and changed its date or
  // venue, the doc id changes (date+venue is the key). Write the new doc and
  // remove the old one in a single atomic batch so there's never a duplicate
  // or an orphan. Any matching eventContent (same key scheme) follows the move.
  const oldKey = (originalDate && originalVenue)
    ? normalizeEventKey(originalDate, originalVenue)
    : null;
  const isMove = oldKey && oldKey !== key;

  const batch = db.batch();
  batch.set(db.collection('schedule').doc(key), {
    date,
    venue,
    location: venue, // dual-write: some readers use `location` (GAS naming)
    type: safeType,
    theme: theme || '',
    gearDescription: (gearDescription || '').trim(),
    announcementNote: (announcementNote || '').trim(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  if (isMove) {
    batch.delete(db.collection('schedule').doc(oldKey));
    // Carry event content (description/image/fb url) over to the new key.
    const oldContent = await db.collection('eventContent').doc(oldKey).get();
    if (oldContent.exists) {
      batch.set(db.collection('eventContent').doc(key),
        { ...oldContent.data(), date, venue, updatedAt: FieldValue.serverTimestamp() },
        { merge: true });
      batch.delete(db.collection('eventContent').doc(oldKey));
    }
  }

  await batch.commit();

  return {
    status: 'success',
    key,
    moved: isMove,
    message: isMove
      ? `Schedule entry moved to ${date} @ ${venue}`
      : `Schedule entry saved for ${date} @ ${venue}`
  };
});

/**
 * Delete a schedule entry from the native Firestore `schedule` collection.
 * Removes the schedule doc; associated eventContent (if any) is left as-is.
 */
exports.deleteScheduleEntry = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { date, venue } = request.data || {};
  if (!date || !venue) {
    throw new HttpsError('invalid-argument', 'date and venue are required');
  }

  const key = normalizeEventKey(date, venue);
  await db.collection('schedule').doc(key).delete();

  return { status: 'success', key, message: `Schedule entry deleted for ${date} @ ${venue}` };
});

/**
 * Get schedule
 * Reads natively from the Firestore `schedule` collection (source of truth as
 * of the 2026-05-30 GAS cutover) and merges Firestore event content.
 *
 * Filtering mirrors the PokerAPI.getSchedule client wrapper in firebase-api.js:
 *   - { all: true }        -> every event
 *   - { historical: true } -> past events only
 *   - default              -> upcoming events only (today onward)
 */
exports.getSchedule = onCall(async (request) => {
  const { historical, all, includeDrafts = false } = request.data || {};

  try {
    if (includeDrafts) await requireRole(request, ['admin']);
    const [scheduleSnap, contentSnap] = await Promise.all([
      db.collection('schedule').get(),
      db.collection('eventContent').get()
    ]);

    const contentMap = {};
    contentSnap.forEach(doc => { contentMap[doc.id] = doc.data(); });

    // Venue-local "today" (see APP_TIMEZONE) — a bare new Date() here is UTC
    // and drops tonight's event from the upcoming list after 6pm Mountain.
    const today = appToday();

    const schedule = [];
    scheduleSnap.forEach(doc => {
      const data = doc.data();
      const candidate = contentMap[doc.id];
      const content = candidate && (includeDrafts || candidate.status !== 'draft') ? candidate : null;
      const event = content
        ? { ...data, title: content.title || '', description: content.description || '', image: content.imageUrl || '', facebookEventUrl: content.facebookEventUrl || '', contentStatus: content.status || 'published' }
        : { ...data };

      const evtDate = new Date(event.date);
      evtDate.setHours(12, 0, 0, 0); // noon-anchor to ignore timezone shifts
      const isPast = evtDate < today;

      if (all || (historical && isPast) || (!historical && !isPast)) {
        schedule.push(event);
      }
    });

    schedule.sort((a, b) => new Date(a.date) - new Date(b.date));

    return { schedule };

  } catch (error) {
    console.error('Get schedule error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Save event content (description + imageUrl) to Firestore.
 * Image is uploaded directly from the browser to Firebase Storage —
 * this function just stores the resulting URL alongside the description.
 */
exports.saveEventContent = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { date, venue, title, description, imageUrl, facebookEventUrl, status } = request.data || {};
  if (!date || !venue) throw new HttpsError('invalid-argument', 'date and venue are required');
  if (status !== undefined && !['draft', 'published'].includes(status)) throw new HttpsError('invalid-argument', 'status must be draft or published');

  const key = normalizeEventKey(date, venue);

  const update = {
    date,
    venue,
    title: title || '',
    description: description || '',
    updatedAt: FieldValue.serverTimestamp()
  };
  if (imageUrl) update.imageUrl = imageUrl;
  if (status !== undefined) update.status = status;
  // Store Facebook Event URL — allow explicit clearing via empty string
  if (facebookEventUrl !== undefined) update.facebookEventUrl = facebookEventUrl || '';

  await db.collection('eventContent').doc(key).set(update, { merge: true });
  return { success: true };
});

// ===========================================
// SEASON MANAGEMENT
// ===========================================

/**
 * Create or update a season
 * Seasons define the date window for points tracking
 */
exports.saveSeason = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { seasonId, name, venue, startDate, endDate, championshipDate, seasonNumber } = request.data;

  // endDate is OPTIONAL. Left blank, the season runs until the next season for
  // this venue starts (resolveSeasonEnd), so a season with a fluid end needs no
  // edit — booting the next one closes it automatically.
  if (!name || !venue || !startDate) {
    throw new HttpsError('invalid-argument', 'Missing required fields: name, venue, startDate');
  }

  try {
    const seasonData = {
      name: name.trim(),
      venue: venue.trim(),
      startDate: normalizeDate(startDate),
      endDate: endDate ? normalizeDate(endDate) : null,
      championshipDate: championshipDate ? normalizeDate(championshipDate) : null,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (seasonNumber !== undefined && seasonNumber !== null && seasonNumber !== '') {
      const n = Number(seasonNumber);
      if (!Number.isNaN(n)) seasonData.seasonNumber = n;
    }

    let ref;
    if (seasonId) {
      // Update existing
      ref = db.collection('seasons').doc(seasonId);
      await ref.update(seasonData);
    } else {
      // Create new
      seasonData.createdAt = FieldValue.serverTimestamp();
      ref = await db.collection('seasons').add(seasonData);
    }

    return {
      status: 'success',
      seasonId: seasonId || ref.id,
      message: `Season "${name}" saved`
    };

  } catch (error) {
    console.error('Save season error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * List all seasons, optionally filtered by venue
 */
exports.listSeasons = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { venue } = request.data || {};

  try {
    let query = db.collection('seasons');
    if (venue) {
      query = query.where('venue', '==', venue);
    }

    const snapshot = await query.get();
    const seasons = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Sort by startDate descending (newest first)
    seasons.sort((a, b) => {
      const dA = new Date(a.startDate);
      const dB = new Date(b.startDate);
      return dB - dA;
    });

    return { seasons };

  } catch (error) {
    console.error('List seasons error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Delete a season
 */
exports.deleteSeason = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { seasonId } = request.data;

  if (!seasonId) {
    throw new HttpsError('invalid-argument', 'Missing seasonId');
  }

  try {
    await db.collection('seasons').doc(seasonId).delete();
    return { status: 'success', message: 'Season deleted' };
  } catch (error) {
    console.error('Delete season error:', error);
    throw new HttpsError('internal', error.message);
  }
});

// ===========================================
// AUTO-QUALIFIERS (Staff Portal)
// Manual championship berths per venue + season, merged into
// getLeaderboard's `qualified` flag. Stored in config/autoQualifiers:
// { [venue]: { [seasonNumber]: [{ name, note, addedBy, addedAt }] } }
// ===========================================

/**
 * List a venue's seasons + its auto-qualifiers, and which season is current.
 */
exports.getAutoQualifiers = onCall(async (request) => {
  await requireRole(request, ['staff', 'admin']);
  const { venue } = request.data || {};
  if (!venue) {
    throw new HttpsError('invalid-argument', 'Missing venue');
  }

  try {
    const seasonsSnap = await db.collection('seasons')
      .where('venue', '==', venue)
      .get();
    // Seasons without a seasonNumber predate per-season keying and can't hold qualifiers
    const seasons = seasonsSnap.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(s => s.seasonNumber !== undefined && s.seasonNumber !== null)
      .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

    // Same pick as getLeaderboard's auto-detect (startDate-keyed)
    const current = pickCurrentSeason(seasons);

    const aqDoc = await db.collection('config').doc('autoQualifiers').get();
    const qualifiers = aqDoc.exists ? (aqDoc.data()[venue] || {}) : {};

    return {
      status: 'success',
      seasons: seasons.map(s => ({
        id: s.id,
        name: s.name || '',
        seasonNumber: s.seasonNumber,
        startDate: s.startDate,
        endDate: s.endDate,
        championshipDate: s.championshipDate || 'TBD'
      })),
      currentSeasonNumber: current ? current.seasonNumber : null,
      qualifiers
    };
  } catch (error) {
    console.error('Get auto-qualifiers error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Add a manual auto-qualifier for a venue + season.
 */
exports.addAutoQualifier = onCall(async (request) => {
  await requireRole(request, ['staff', 'admin']);
  const { venue, seasonNumber, player, note } = request.data || {};
  const name = String(player || '').trim();

  if (!venue || seasonNumber === undefined || seasonNumber === null || !name) {
    throw new HttpsError('invalid-argument', 'Missing venue, seasonNumber, or player');
  }

  try {
    const ref = db.collection('config').doc('autoQualifiers');
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      const venueMap = data[venue] || {};
      const key = String(seasonNumber);
      const list = Array.isArray(venueMap[key]) ? venueMap[key] : [];

      const nameLower = name.toLowerCase();
      const exists = list.some(e =>
        (typeof e === 'string' ? e : (e && e.name) || '').toLowerCase() === nameLower
      );
      if (exists) {
        throw new HttpsError('already-exists', `${name} is already an auto-qualifier for season ${seasonNumber}.`);
      }

      list.push({
        name,
        note: String(note || '').trim() || null,
        addedBy: request.auth?.uid || null,
        addedAt: new Date().toISOString()
      });
      venueMap[key] = list;
      data[venue] = venueMap;
      tx.set(ref, data);
    });

    return { status: 'success', message: `${name} auto-qualified for season ${seasonNumber}` };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('Add auto-qualifier error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Remove a manual auto-qualifier for a venue + season.
 */
exports.removeAutoQualifier = onCall(async (request) => {
  await requireRole(request, ['staff', 'admin']);
  const { venue, seasonNumber, player } = request.data || {};
  const name = String(player || '').trim();

  if (!venue || seasonNumber === undefined || seasonNumber === null || !name) {
    throw new HttpsError('invalid-argument', 'Missing venue, seasonNumber, or player');
  }

  try {
    const ref = db.collection('config').doc('autoQualifiers');
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data();
      const venueMap = data[venue] || {};
      const key = String(seasonNumber);
      const list = Array.isArray(venueMap[key]) ? venueMap[key] : [];

      const nameLower = name.toLowerCase();
      venueMap[key] = list.filter(e =>
        (typeof e === 'string' ? e : (e && e.name) || '').toLowerCase() !== nameLower
      );
      data[venue] = venueMap;
      tx.set(ref, data);
    });

    return { status: 'success', message: `${name} removed from season ${seasonNumber} auto-qualifiers` };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('Remove auto-qualifier error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Set the consolation winner for a venue.
 * Writes to /config/consolationWinners (active config for next season)
 * and records history in /qualifiers linked to the given seasonId.
 */
exports.setConsolationWinner = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { venue, players, player, seasonId } = request.data;

  if (!venue || !seasonId) {
    throw new HttpsError('invalid-argument', 'Missing required fields: venue, seasonId');
  }

  // Accept players (array, 0-2) or legacy player (single string)
  const rawList = players || (player ? [player] : []);
  const winners = rawList.map(p => p.trim()).filter(Boolean);

  try {
    const batch = db.batch();

    // Write array to config (0, 1, or 2 winners)
    const configRef = db.collection('config').doc('consolationWinners');
    batch.set(configRef, { [venue]: winners }, { merge: true });

    // Record one historical qualifier doc per winner
    winners.forEach(w => {
      const qualRef = db.collection('qualifiers').doc();
      batch.set(qualRef, {
        player: w,
        venue: venue,
        seasonId: seasonId,
        type: 'consolation',
        createdAt: FieldValue.serverTimestamp()
      });
    });

    await batch.commit();

    const msg = winners.length === 0
      ? `No consolation qualifiers set for ${venue}`
      : `${winners.join(' & ')} set as consolation qualifier(s) for ${venue}`;
    return { status: 'success', message: msg };
  } catch (error) {
    console.error('setConsolationWinner error:', error);
    throw new HttpsError('internal', error.message);
  }
});

// ===========================================
// ADMIN UTILITIES
// ===========================================

/**
 * Get full season matrix data from Firestore
 * Returns points and bounties organized as a matrix (players x game dates)
 * No UI since admin/matrix-editor.html was removed 2026-09-05; kept for scripts.
 */
exports.getSeasonMatrix = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { venue, seasonId } = request.data;

  if (!venue) {
    throw new HttpsError('invalid-argument', 'Missing venue');
  }

  try {
    // Load season date range if specified
    let seasonStart = null;
    let seasonEnd = null;
    let seasonInfo = null;

    if (seasonId) {
      const seasonDoc = await db.collection('seasons').doc(seasonId).get();
      if (seasonDoc.exists) {
        const s = seasonDoc.data();
        seasonStart = new Date(s.startDate);
        seasonEnd = new Date(s.endDate);
        // Add a day buffer to endDate to include games on that date
        seasonEnd.setHours(23, 59, 59, 999);
        seasonInfo = { id: seasonDoc.id, name: s.name, startDate: s.startDate, endDate: s.endDate, championshipDate: s.championshipDate };
      }
    }

    // Helper to check if a date string falls within the season
    function isInSeason(dateStr) {
      if (!seasonStart || !seasonEnd) return true; // No season filter = include all
      const d = new Date(dateStr);
      return d >= seasonStart && d <= seasonEnd;
    }

    // Get all eliminations for this venue (active + processed)
    const elimsSnapshot = await db.collection('eliminations')
      .where('venue', '==', venue)
      .get();

    // Get all bounties for this venue
    const bountiesSnapshot = await db.collection('bounties')
      .where('venue', '==', venue)
      .get();

    // Get all checkins for this venue (for attendance-only players)
    const checkinsSnapshot = await db.collection('checkins')
      .where('venue', '==', venue)
      .get();

    // Collect all unique dates and players
    const dates = new Set();
    const players = new Set();

    // Points matrix: { playerName: { "date|gameNum": points } }
    const pointsData = {};
    // Bounty matrix: { playerName: { "date|gameNum": count } }
    const bountyData = {};
    // Track raw elimination data for editing
    const elimDetails = {};

    // Process eliminations
    elimsSnapshot.docs.forEach(doc => {
      const d = doc.data();
      if (d.status === 'removed') return;
      if (!d.player || !d.date) return;
      if (!isInSeason(d.date)) return;

      const key = `${d.date}|${d.gameNum}`;
      dates.add(key);
      players.add(d.player);

      if (!pointsData[d.player]) pointsData[d.player] = {};
      if (!elimDetails[d.player]) elimDetails[d.player] = {};

      // Calculate points: use totalPoints if available, else bonusPoints + attendance
      let pts = 0;
      if (d.totalPoints !== undefined && d.totalPoints !== null) {
        pts = d.totalPoints;
      } else if (d.bonusPoints !== undefined && d.bonusPoints !== null) {
        pts = d.bonusPoints + ATTENDANCE_POINTS;
      } else if (d.rank && d.rank <= 10) {
        pts = (BONUS_POINTS[d.rank] || 0) + ATTENDANCE_POINTS;
      } else {
        pts = ATTENDANCE_POINTS;
      }

      pointsData[d.player][key] = pts;
      elimDetails[d.player][key] = {
        docId: doc.id,
        rank: d.rank,
        bonusPoints: d.bonusPoints,
        totalPoints: d.totalPoints,
        status: d.status
      };
    });

    // Process checkins for attendance-only players
    checkinsSnapshot.docs.forEach(doc => {
      const d = doc.data();
      if (d.status === 'removed') return;
      if (!d.player || !d.date) return;
      if (!isInSeason(d.date)) return;

      const key = `${d.date}|${d.gameNum}`;
      dates.add(key);
      players.add(d.player);

      // Only add attendance points if no elimination entry
      if (!pointsData[d.player]) pointsData[d.player] = {};
      if (!pointsData[d.player][key]) {
        pointsData[d.player][key] = ATTENDANCE_POINTS;
      }
    });

    // Process bounties
    bountiesSnapshot.docs.forEach(doc => {
      const d = doc.data();
      if (d.status === 'removed') return;
      if (!d.player || !d.date) return;
      if (!isInSeason(d.date)) return;

      const key = `${d.date}|${d.gameNum}`;
      dates.add(key);
      players.add(d.player);

      if (!bountyData[d.player]) bountyData[d.player] = {};
      bountyData[d.player][key] = {
        count: d.count || 0,
        docId: doc.id
      };
    });

    // Sort dates chronologically
    const sortedDates = Array.from(dates).sort((a, b) => {
      const [dateA, gameA] = a.split('|');
      const [dateB, gameB] = b.split('|');
      const dA = new Date(dateA);
      const dB = new Date(dateB);
      if (dA.getTime() !== dB.getTime()) return dA - dB;
      return parseInt(gameA) - parseInt(gameB);
    });

    // Sort players alphabetically
    const sortedPlayers = Array.from(players).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    // Calculate totals per player
    const playerTotals = {};
    const playerBountyTotals = {};
    for (const player of sortedPlayers) {
      playerTotals[player] = Object.values(pointsData[player] || {}).reduce((s, v) => s + v, 0);
      playerBountyTotals[player] = Object.values(bountyData[player] || {}).reduce((s, v) => s + (v.count || 0), 0);
    }

    return {
      venue,
      seasonInfo,
      dates: sortedDates,
      players: sortedPlayers,
      points: pointsData,
      bounties: bountyData,
      elimDetails,
      playerTotals,
      playerBountyTotals
    };

  } catch (error) {
    console.error('Get season matrix error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Update a single cell in the matrix (edit points or bounty for a player/date/game)
 */
exports.updateMatrixCell = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { venue, player, date, gameNum, type, value } = request.data;

  if (!venue || !player || !date || !gameNum || !type) {
    throw new HttpsError('invalid-argument', 'Missing required fields');
  }

  const normalizedDate = normalizeDate(date);
  const playerLower = player.trim().toLowerCase();

  try {
    if (type === 'points') {
      const newPoints = parseInt(value) || 0;

      // Find existing elimination
      const elimQuery = await db.collection('eliminations')
        .where('playerLower', '==', playerLower)
        .where('date', '==', normalizedDate)
        .where('gameNum', '==', parseInt(gameNum))
        .where('venue', '==', venue)
        .where('status', 'in', ['active', 'processed'])
        .limit(1)
        .get();

      if (!elimQuery.empty) {
        // Update existing elimination
        const doc = elimQuery.docs[0];
        await doc.ref.update({
          totalPoints: newPoints,
          bonusPoints: Math.max(0, newPoints - ATTENDANCE_POINTS),
          updatedAt: FieldValue.serverTimestamp(),
          syncedToGAS: false
        });
      } else if (newPoints > 0) {
        // Check if there's a checkin (attendance-only scenario)
        // If editing to > 10 points, create an elimination entry
        if (newPoints > ATTENDANCE_POINTS) {
          // Reverse-calculate rank from points
          const bonusPoints = newPoints - ATTENDANCE_POINTS;
          let rank = 11; // default: no bonus
          for (const [r, pts] of Object.entries(BONUS_POINTS)) {
            if (pts === bonusPoints) { rank = parseInt(r); break; }
          }

          await db.collection('eliminations').add({
            player: player.trim(),
            playerLower: playerLower,
            date: normalizedDate,
            gameNum: parseInt(gameNum),
            venue: venue,
            rank: rank,
            bonusPoints: bonusPoints,
            totalPoints: newPoints,
            status: 'processed',
            createdAt: FieldValue.serverTimestamp(),
            syncedToGAS: false,
            editedManually: true
          });
        }
        // If exactly 10, it's attendance-only, nothing extra to do
      }

      return { status: 'success', message: `Points updated to ${newPoints}` };

    } else if (type === 'bounty') {
      const newCount = parseInt(value) || 0;

      // Find existing bounty
      const bountyQuery = await db.collection('bounties')
        .where('playerLower', '==', playerLower)
        .where('date', '==', normalizedDate)
        .where('gameNum', '==', parseInt(gameNum))
        .where('venue', '==', venue)
        .where('status', 'in', ['active', 'processed'])
        .limit(1)
        .get();

      if (!bountyQuery.empty) {
        await bountyQuery.docs[0].ref.update({
          count: newCount,
          updatedAt: FieldValue.serverTimestamp(),
          syncedToGAS: false
        });
      } else if (newCount > 0) {
        await db.collection('bounties').add({
          player: player.trim(),
          playerLower: playerLower,
          date: normalizedDate,
          gameNum: parseInt(gameNum),
          venue: venue,
          count: newCount,
          status: 'processed',
          createdAt: FieldValue.serverTimestamp(),
          syncedToGAS: false,
          editedManually: true
        });
      }

      return { status: 'success', message: `Bounty updated to ${newCount}` };
    }

    throw new HttpsError('invalid-argument', 'Type must be "points" or "bounty"');

  } catch (error) {
    console.error('Update matrix cell error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Rename a player across all Firestore collections
 * Simple rename (not merge) - just changes the display name
 */
exports.renamePlayer = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { oldName, newName } = request.data;

  if (!oldName || !newName) {
    throw new HttpsError('invalid-argument', 'Missing oldName or newName');
  }

  const oldLower = oldName.trim().toLowerCase();
  const newLower = newName.trim().toLowerCase();
  const batch = db.batch();
  let updatedCount = 0;

  try {
    // Update player record
    const playerQuery = await db.collection('players')
      .where('nameLower', '==', oldLower)
      .limit(1)
      .get();

    if (!playerQuery.empty) {
      batch.update(playerQuery.docs[0].ref, {
        name: newName.trim(),
        nameLower: newLower,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    // Update all collections
    const collections = ['checkins', 'eliminations', 'bounties', 'rsvps'];
    for (const coll of collections) {
      const query = await db.collection(coll)
        .where('playerLower', '==', oldLower)
        .get();
      query.docs.forEach(doc => {
        batch.update(doc.ref, {
          player: newName.trim(),
          playerLower: newLower
        });
        updatedCount++;
      });
    }

    await batch.commit();

    return {
      status: 'success',
      message: `Renamed "${oldName}" to "${newName}"`,
      updatedRecords: updatedCount
    };

  } catch (error) {
    console.error('Rename player error:', error);
    throw new HttpsError('internal', error.message);
  }
});


/**
 * Email signup from landing page
 * Adds to emailList collection and fuzzy-matches name against existing players
 */
exports.emailSignup = onCall(async (request) => {
  const { name, email } = request.data || {};

  if (typeof name !== 'string' || typeof email !== 'string' || !name.trim() || !email.trim()) {
    throw new HttpsError('invalid-argument', 'Name and email are required.');
  }

  const nameClean = name.trim();
  const emailClean = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
  }

  try {
    // Check if email already on list
    const existingEmail = await db.collection('emailList')
      .where('email', '==', emailClean)
      .limit(1)
      .get();

    if (!existingEmail.empty) {
      return { status: 'already_subscribed', message: "You're already on our list!" };
    }

    // Fuzzy match name against existing players
    const playersSnapshot = await db.collection('players').orderBy('name').get();
    const players = playersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    let matchedPlayer = null;
    let matchedPlayerId = null;
    let bestSimilarity = 0;

    for (const player of players) {
      const sim = calculateNameSimilarity(nameClean, player.name);
      if (sim >= 0.85 && sim > bestSimilarity) {
        bestSimilarity = sim;
        matchedPlayer = player.name;
        matchedPlayerId = player.id;
      }
    }

    // Add to emailList
    await db.collection('emailList').add({
      name: nameClean,
      email: emailClean,
      source: 'landing_page',
      linkedPlayer: matchedPlayer || null,
      addedAt: FieldValue.serverTimestamp()
    });

    // This page runs signed out, so it may only fill in a missing contact
    // email, never replace one (same rule as updatePlayerEmail).
    const subscribedOnly = {
      status: 'subscribed',
      message: "You're on the list! We'll reach out before upcoming games."
    };

    if (matchedPlayerId) {
      const { preservedEmail } = await savePlayerContactEmail(
        db.collection('players').doc(matchedPlayerId), emailClean, 'landing_page', false);
      if (preservedEmail) return subscribedOnly;
      return {
        status: 'linked',
        message: "You're on the list! We linked your email to your player profile.",
        matchedPlayer
      };
    }

    // No fuzzy match — check exact name (case-insensitive)
    const nameLower = nameClean.toLowerCase();
    const exactMatch = await db.collection('players')
      .where('nameLower', '==', nameLower)
      .limit(1)
      .get();

    if (!exactMatch.empty) {
      const { preservedEmail } = await savePlayerContactEmail(
        exactMatch.docs[0].ref, emailClean, 'landing_page', false);
      if (preservedEmail) return subscribedOnly;
      return {
        status: 'linked',
        message: "You're on the list! We linked your email to your player profile.",
        matchedPlayer: exactMatch.docs[0].data().name
      };
    }

    // New person — add as new player
    const newPlayer = await db.collection('players').add({
      name: nameClean,
      nameLower: nameLower,
      createdAt: FieldValue.serverTimestamp(),
      addedVia: 'email_signup'
    });
    await db.collection('playerContacts').doc(newPlayer.id).set({
      email: emailClean,
      emailAddedAt: FieldValue.serverTimestamp(),
      source: 'landing_page'
    }, { merge: true });

    return {
      status: 'subscribed',
      message: "You're on the list! We'll reach out before upcoming games."
    };

  } catch (error) {
    console.error('Email signup error:', error);
    throw new HttpsError('internal', error.message);
  }
});

// Signed in with a real account: not signed out, and not one of the contest
// app's anonymous accounts (the same line firestore.rules signedIn() draws).
function hasPokerAccount(request) {
  return !!request.auth?.uid && request.auth.token?.firebase?.sign_in_provider !== 'anonymous';
}

/**
 * May this caller replace the stored email on the roster player named
 * playerName (that record's own spelling)? Yes for staff and admins, and for
 * the signed-in player whose profile's linkedName is exactly that name, as the
 * claim flow on index.html writes it, while no other profile claims it. A
 * case or spacing variant of the name counts for nothing, so it cannot slip
 * past the claim count. Signed-out callers and anonymous accounts never may.
 */
async function mayReplacePlayerEmail(request, playerName) {
  if (!hasPokerAccount(request)) return false;

  const snap = await db.collection('userProfiles').doc(request.auth.uid).get();
  const profile = snap.exists ? snap.data() || {} : {};
  if (hasStaffRole(profile)) return true;

  if (typeof playerName !== 'string' || !playerName || profile.linkedName !== playerName) return false;
  const claims = await db.collection('userProfiles')
    .where('linkedName', '==', playerName)
    .limit(2)
    .get();
  return claims.size === 1;
}

/**
 * Write a player's email to playerContacts/{playerId}, the only place player
 * emails live (docs/PLAYER_EMAIL_PRIVACY.md). With replace false, an email
 * already stored is kept; so is a legacy players.email, which is copied to
 * playerContacts first. Returns { preservedEmail }: the address kept, or null
 * when the new one was written.
 */
async function savePlayerContactEmail(playerRef, email, source, replace) {
  const contactRef = db.collection('playerContacts').doc(playerRef.id);
  return db.runTransaction(async (transaction) => {
    const existingContact = await transaction.get(contactRef);
    const contactData = existingContact.exists ? existingContact.data() || {} : {};
    const contactEmail = String(contactData.email || '').trim();

    if (!replace && contactEmail) {
      return { preservedEmail: contactEmail };
    }

    if (!contactEmail) {
      const currentPlayer = await transaction.get(playerRef);
      const legacyPlayer = currentPlayer.exists ? currentPlayer.data() || {} : {};
      const legacyEmail = String(legacyPlayer.email || '').trim();
      if (legacyEmail) {
        const backfill = {
          email: legacyEmail,
          source: 'legacy_backfill'
        };
        if (legacyPlayer.emailAddedAt) backfill.emailAddedAt = legacyPlayer.emailAddedAt;
        transaction.set(contactRef, backfill, { merge: true });

        if (!replace) return { preservedEmail: legacyEmail };
      }
    }

    transaction.set(contactRef, {
      email,
      emailAddedAt: FieldValue.serverTimestamp(),
      source
    }, { merge: true });
    return { preservedEmail: null };
  });
}

/**
 * Save email for a player (check-in kiosk, account link, profile edit).
 *
 * Anyone may fill in an email a player does not have yet: the kiosk runs
 * signed out and offers it when a new player checks in. Replacing a stored
 * email needs mayReplacePlayerEmail(). Without it the stored address is kept
 * and never echoed: the signed-out kiosk and anonymous callers get a normal
 * reply, and a signed-in caller who asked to replace gets permission-denied
 * so the profile page does not report a change that did not happen.
 */
exports.updatePlayerEmail = onCall(async (request) => {
  const { player, email, source = 'profile' } = request.data || {};

  if (typeof player !== 'string' || typeof email !== 'string' || !player.trim() || !email.trim()) {
    throw new HttpsError('invalid-argument', 'Player name and email are required.');
  }

  const emailClean = email.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    throw new HttpsError('invalid-argument', 'Invalid email address.');
  }

  const playerLower = player.trim().toLowerCase();
  const wantsReplace = !request.data.onlyIfMissing;

  try {
    let finalEmail = emailClean;
    let preservedExisting = false;

    // Update player record
    const playerQuery = await db.collection('players')
      .where('nameLower', '==', playerLower)
      .limit(1)
      .get();

    if (!playerQuery.empty) {
      const playerDoc = playerQuery.docs[0];
      const replace = wantsReplace && await mayReplacePlayerEmail(request, playerDoc.data().name);
      const { preservedEmail } = await savePlayerContactEmail(playerDoc.ref, emailClean, source, replace);

      if (preservedEmail) {
        if (wantsReplace && hasPokerAccount(request)) {
          throw new HttpsError('permission-denied',
            'This account cannot change that player\'s contact email. Please see the Tournament Director.');
        }
        finalEmail = preservedEmail.toLowerCase();
        preservedExisting = true;
      }
    }

    // Add to emailList if not already there
    const existingEmail = await db.collection('emailList')
      .where('email', '==', finalEmail)
      .limit(1)
      .get();

    if (existingEmail.empty) {
      await db.collection('emailList').add({
        name: player.trim(),
        email: finalEmail,
        source,
        linkedPlayer: player.trim(),
        addedAt: FieldValue.serverTimestamp()
      });
    }

    return {
      status: 'success',
      // Never echo a stored address back: this callable runs signed out (kiosk),
      // so returning an existing email would let anyone look one up by name.
      email: preservedExisting ? null : finalEmail,
      preservedExisting
    };

  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('Update player email error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Every write admin/game-inspector.html makes, moved server-side (2026-10-19)
 * so the rules no longer let an admin's browser write game rows directly.
 * Each op writes exactly what the page used to write, so finalized games
 * read the same as before. The scoring callables (recordElimination,
 * recordBounty, undoScoring, removeCheckin) are not reused: they look rows up
 * by playerLower and status, soft-delete, and leave bonusPoints for finalize,
 * none of which matches the inspector's rows or its hard deletes.
 *
 * ops: setRank { elimId, rank }, setBounty { bountyId, count },
 *      removePlayer { checkinId, elimId, bountyId }, addPlayer {}.
 * All take { venue, date, gameNum, player }. Any id passed must name a row of
 * that same game and player.
 */
exports.adminEditGameRecord = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const data = request.data || {};
  const { op } = data;

  const venue = typeof data.venue === 'string' ? data.venue.trim() : '';
  const date = typeof data.date === 'string' ? data.date.trim() : '';
  const gameNum = data.gameNum;
  const player = typeof data.player === 'string' ? data.player.trim() : '';
  if (!venue || venue.length > 60 || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)
      || !Number.isInteger(gameNum) || gameNum < 1 || gameNum > 9
      || !player || player.length > 100) {
    throw new HttpsError('invalid-argument', 'venue, date (M/D/YYYY), gameNum and player are required.');
  }
  const game = { venue, date, gameNum };

  // Returns the ref for an id the page passed, after checking that the row
  // belongs to this game and player. A row already gone returns its ref with
  // exists=false, so a repeated delete is harmless.
  async function rowFor(collectionName, id) {
    if (id === undefined || id === null || id === '') return null;
    if (typeof id !== 'string' || id.includes('/') || id.length > 128) {
      throw new HttpsError('invalid-argument', 'Bad document id.');
    }
    const ref = db.collection(collectionName).doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      const row = snap.data() || {};
      const sameGame = row.venue === venue && row.date === date && Number(row.gameNum) === gameNum;
      const samePlayer = String(row.player || '').trim().toLowerCase() === player.toLowerCase();
      if (!sameGame || !samePlayer) {
        throw new HttpsError('failed-precondition', `That ${collectionName} row belongs to another game or player.`);
      }
    }
    return { ref, exists: snap.exists };
  }

  if (op === 'setRank') {
    const rank = data.rank === null || data.rank === undefined || data.rank === '' ? null : data.rank;
    if (rank !== null && !(Number.isInteger(rank) && BONUS_POINTS[rank])) {
      throw new HttpsError('invalid-argument', 'rank must be 1 to 10, or null to clear it.');
    }
    const row = await rowFor('eliminations', data.elimId);
    const fields = { player, rank, ...game, bonusPoints: BONUS_POINTS[rank] || 0 };
    if (row) {
      if (rank) await row.ref.set(fields, { merge: true });
      else await row.ref.delete();
      return { status: 'success', elimId: rank ? row.ref.id : null };
    }
    if (!rank) return { status: 'success', elimId: null };
    const ref = await db.collection('eliminations').add(fields);
    return { status: 'success', elimId: ref.id };
  }

  if (op === 'setBounty') {
    const count = parseInt(data.count, 10) || 0;
    if (count > 99) throw new HttpsError('invalid-argument', 'count must be 0 to 99.');
    const row = await rowFor('bounties', data.bountyId);
    const fields = { player, count, ...game };
    if (count > 0) {
      if (row) {
        await row.ref.set(fields, { merge: true });
        return { status: 'success', bountyId: row.ref.id };
      }
      const ref = await db.collection('bounties').add(fields);
      return { status: 'success', bountyId: ref.id };
    }
    if (row) await row.ref.delete();
    return { status: 'success', bountyId: null };
  }

  if (op === 'removePlayer') {
    const rows = [
      await rowFor('checkins', data.checkinId),
      await rowFor('eliminations', data.elimId),
      await rowFor('bounties', data.bountyId)
    ].filter(Boolean);
    const batch = db.batch();
    rows.forEach(row => batch.delete(row.ref));
    await batch.commit();
    return { status: 'success', removed: rows.filter(row => row.exists).length };
  }

  if (op === 'addPlayer') {
    const ref = await db.collection('checkins').add({ player, ...game, addedByAdmin: true });
    return { status: 'success', checkinId: ref.id };
  }

  throw new HttpsError('invalid-argument', 'Unknown op.');
});

/**
 * Called by admin game inspector when manually adding a player to a game.
 * Marks the checkin as attendanceOnly and syncs 10 pts to the Matrix immediately,
 * so already-finalized games get credited without re-running finalizeGame.
 */
exports.adminSyncAttendance = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { checkinId, player, date, gameNum, venue } = request.data;

  if (!checkinId || !player || !date || !gameNum || !venue) {
    throw new HttpsError('invalid-argument', 'checkinId, player, date, gameNum, and venue are required.');
  }

  const normalizedDate = date.includes('-')
    ? date
    : (() => {
        const [m, d, y] = date.split('/');
        return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      })();

  try {
    // Mark the checkin as attendanceOnly and syncedToGAS so finalizeGame skips it
    await db.collection('checkins').doc(checkinId).update({
      attendanceOnly: true,
      syncedToGAS: true,
      processedAt: FieldValue.serverTimestamp()
    });

    console.log(`adminSyncAttendance: ${player} +${ATTENDANCE_POINTS} pts for ${venue} ${normalizedDate} game ${gameNum}`);
    return { status: 'success', points: ATTENDANCE_POINTS };
  } catch (error) {
    console.error('adminSyncAttendance error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Get season game-by-game breakdown for public stats page
 * Returns all games in the current season with full player results per game
 */
exports.getSeasonBreakdown = onCall(async (request) => {
  const { venue, seasonId } = request.data;

  if (!venue) {
    throw new HttpsError('invalid-argument', 'Missing venue');
  }

  try {
    // Season + effective window (same resolver as getLeaderboard)
    const resolved = await resolveSeasonForVenue(venue, seasonId);
    const startDate = resolved.startDate;
    const endDate = resolved.endDate;
    const seasonName = resolved.seasonName;
    const seasonNumber = resolved.seasonNumber; // captured for consistent filtering

    // Use the same strict validation as getLeaderboard: rejects Invalid Date records
    // and enforces the season window precisely.
    function inDateRange(dateStr) {
      return isInSeasonWindow(dateStr, startDate, endDate);
    }

    // Big Stack / Championship nights, excluded by date regardless of window
    const nonSeasonDates = await loadNonSeasonDates(venue);

    const games = {}; // gameKey => { date, gameNum, players: {} }

    function getOrCreateGame(date, gameNum) {
      const key = `${date}-${gameNum}`;
      if (!games[key]) games[key] = { date, gameNum, players: {} };
      return games[key];
    }

    // Eliminations
    const elimsSnap = await db.collection('eliminations').where('venue', '==', venue).get();
    elimsSnap.docs.forEach(doc => {
      const data = doc.data();
      if (data.status === 'removed') return;
      if (!isSeasonEligibleGameType(data.gameType)) return; // Regular only
      if (nonSeasonDates.has(dateKey(data.date))) return;
      if (!inDateRange(data.date)) return;
      if (!data.player) return;
      // Enforce season number when present (mirrors getLeaderboard).
      if (data.season !== undefined && data.season !== null
          && seasonNumber !== undefined && seasonNumber !== null
          && Number(data.season) !== Number(seasonNumber)) return;

      const game = getOrCreateGame(data.date, data.gameNum);

      let totalPoints = 0;
      let displayRank = data.rank;
      if (data.totalPoints !== undefined && data.totalPoints !== null) {
        totalPoints = data.totalPoints;
      } else if (data.bonusPoints !== undefined && data.bonusPoints !== null) {
        totalPoints = data.bonusPoints + ATTENDANCE_POINTS;
      } else if (data.rank !== undefined && data.rank !== null) {
        if (data.rank > 10) {
          totalPoints = data.rank; // Old format: rank IS total points
          displayRank = null;
        } else {
          totalPoints = (BONUS_POINTS[data.rank] || 0) + ATTENDANCE_POINTS;
        }
      }

      game.players[data.player] = {
        name: data.player,
        rank: displayRank,
        totalPoints,
        bounties: 0,
        attendanceOnly: false,
        numTied: data.numTied || 1
      };
    });

    // Bounties
    const bountiesSnap = await db.collection('bounties').where('venue', '==', venue).get();
    const seenBounties = new Set();
    bountiesSnap.docs.forEach(doc => {
      const data = doc.data();
      if (data.status === 'removed') return;
      const bKey = `${(data.player || '').toLowerCase()}|${data.date}|${data.gameNum}`;
      if (seenBounties.has(bKey)) return;
      seenBounties.add(bKey);
      if (nonSeasonDates.has(dateKey(data.date))) return; // bounties carry no gameType
      if (!inDateRange(data.date)) return;
      if (!data.player || !data.count) return;

      const gameKey = `${data.date}-${data.gameNum}`;
      if (games[gameKey] && games[gameKey].players[data.player]) {
        games[gameKey].players[data.player].bounties = data.count;
      }
    });

    // Attendance-only check-ins — apply the same eligibility rules as getLeaderboard
    // so stats.html totals match the leaderboard exactly.
    const checkinsSnap = await db.collection('checkins')
      .where('venue', '==', venue)
      .where('attendanceOnly', '==', true)
      .get();
    checkinsSnap.docs.forEach(doc => {
      const data = doc.data();
      if (data.status === 'removed') return;
      if (!inDateRange(data.date)) return;
      if (!data.player) return;
      // Only season-eligible game types count (excludes Big Stack, Championship, etc.)
      if (!isSeasonEligibleGameType(data.gameType)) return;
      // Enforce season number when the record carries one (prevents cross-season leakage).
      if (data.season !== undefined && data.season !== null
          && seasonNumber !== undefined && seasonNumber !== null
          && Number(data.season) !== Number(seasonNumber)) return;

      const game = getOrCreateGame(data.date, data.gameNum);
      if (!game.players[data.player]) {
        game.players[data.player] = {
          name: data.player,
          rank: null,
          totalPoints: ATTENDANCE_POINTS,
          bounties: 0,
          attendanceOnly: true,
          numTied: 1
        };
      }
    });

    // Build sorted game list: players sorted by rank asc, then attendance-only alpha
    const gameList = Object.values(games).map(game => {
      const players = Object.values(game.players).sort((a, b) => {
        if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
        if (a.rank !== null) return -1;
        if (b.rank !== null) return 1;
        return a.name.localeCompare(b.name);
      });
      return { date: game.date, gameNum: game.gameNum, players };
    });

    // Sort games newest first
    gameList.sort((a, b) => {
      const diff = new Date(b.date) - new Date(a.date);
      return diff !== 0 ? diff : b.gameNum - a.gameNum;
    });

    return { status: 'success', venue, seasonName, games: gameList };

  } catch (error) {
    console.error('getSeasonBreakdown error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Get all subscriber profiles (for League Broadcast page)
 * Runs server-side so Firestore rules don't block the read.
 */
exports.getSubscribers = onCall(async (request) => {
  await requireRole(request, ['admin']);
  try {
    const snap = await db.collection('userProfiles').get();
    const subscribers = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.linkedName) {
        subscribers.push({
          uid: doc.id,
          linkedName: d.linkedName,
          email: d.email || null,
          preferences: d.preferences || {}
        });
      }
    });
    subscribers.sort((a, b) => a.linkedName.localeCompare(b.linkedName));
    return { status: 'success', subscribers };
  } catch (error) {
    console.error('getSubscribers error:', error);
    throw new HttpsError('internal', error.message);
  }
});

exports.saveHighHand = onCall(async (request) => {
  await requireRole(request, ['staff']);
  return doSaveHighHand(request.data || {});
});
async function doSaveHighHand(data) {
  const { venue, player, hand } = data;

  if (!venue || !player || !hand) {
    throw new HttpsError('invalid-argument', 'Missing required fields.');
  }

  const docRef = db.collection('config').doc('highHands');
  const doc = await docRef.get();
  const currentData = doc.exists ? doc.data()[venue] : null;

  // The High Hand leader is a PER-SEASON title. Stamp the season it was won in
  // so a leader can never bleed into the next season (updateHighHandPotForSeason
  // archives and clears any leader whose seasonId isn't the live one).
  let season = null;
  try { season = await resolveSeasonForDate(venue, appTodayStr()); } catch (e) { season = null; }

  const updates = {
    [venue]: {
      player: player.trim(),
      hand: hand.trim(),
      seasonId: season ? season.id : null,
      seasonNumber: season ? (season.seasonNumber ?? null) : null,
      updatedAt: FieldValue.serverTimestamp()
    }
  };

  // Preserve existing auto-calculated pot
  updates[venue].pot = currentData && currentData.pot ? currentData.pot : '0';

  // If the player changed, push the old one to history
  if (currentData && currentData.player && currentData.player.trim().toLowerCase() !== player.trim().toLowerCase()) {
    const history = currentData.history || [];
    // Keep max 20 history items to prevent document growing infinitely
    history.unshift({
      player: currentData.player,
      hand: currentData.hand,
      pot: currentData.pot || '0',
      seasonId: currentData.seasonId || null,
      seasonNumber: currentData.seasonNumber ?? null,
      timestamp: currentData.updatedAt ? currentData.updatedAt.toDate().toISOString() : new Date().toISOString()
    });
    if (history.length > 20) history.length = 20;
    updates[venue].history = history;
  } else if (currentData && currentData.history) {
    // Preserve history if just updating hand for the same player
    updates[venue].history = currentData.history;
  }

  await docRef.set(updates, { merge: true });

  return { status: 'success' };
}

/**
 * Calculates High Hand pot for the season based on qualifying games.
 * A qualifying game is a REGULAR-season game where the total bounty count
 * for that game meets the venue threshold. Each qualifying game adds $10.
 *
 * Bounties are the official source of truth. The schedule is checked so
 * Big Stack / Championship games don't leak into the regular-season pot.
 *
 * Thresholds default to Tight End 27+ / Wild Corgi 35+, but can be
 * changed WITHOUT a deploy via the Firestore doc config/highHand:
 *   { bountyThresholds: { "Tight End": 27, "Wild Corgi": 35 } }
 * Unknown venues return null (no pot accrual).
 */
const DEFAULT_HH_BOUNTY_THRESHOLDS = { 'Tight End': 27, 'Wild Corgi': 35 };
let hhThresholdCache = null; // { value, fetchedAt } — 5 min TTL per instance

async function getHighHandThreshold(venue) {
  const now = Date.now();
  if (!hhThresholdCache || now - hhThresholdCache.fetchedAt > 5 * 60 * 1000) {
    let overrides = {};
    try {
      const snap = await db.collection('config').doc('highHand').get();
      if (snap.exists && snap.data().bountyThresholds) {
        overrides = snap.data().bountyThresholds;
      }
    } catch (e) {
      console.warn('config/highHand read failed, using default thresholds:', e.message);
    }
    hhThresholdCache = { value: { ...DEFAULT_HH_BOUNTY_THRESHOLDS, ...overrides }, fetchedAt: now };
  }
  return hhThresholdCache.value[venue] || null;
}

async function updateHighHandPotForSeason(venue, seasonInfo) {
  // endDate may be null for a live, open-ended season — isInSeasonWindow
  // enforces the start bound on its own, so only startDate is required here.
  if (!seasonInfo || !seasonInfo.startDate) return 0;
  const threshold = await getHighHandThreshold(venue);
  if (!threshold) return 0;

  // Build set of (date) keys that are Regular-type at this venue.
  const scheduleSnap = await db.collection('schedule')
    .where('venue', '==', venue)
    .get();
  const regularDates = new Set();
  scheduleSnap.docs.forEach(doc => {
    const data = doc.data();
    const gt = (data.type === undefined || data.type === null || data.type === '')
      ? 'Regular' : String(data.type);
    if (gt === 'Regular') regularDates.add(data.date);
  });

  const bountiesSnap = await db.collection('bounties')
    .where('venue', '==', venue)
    .where('status', 'in', ['active', 'processed'])
    .get();

  // Sum bounty counts per game (date + gameNum), filtered to Regular games
  // inside the season window.
  const games = {};
  bountiesSnap.docs.forEach(doc => {
    const data = doc.data();
    if (!isInSeasonWindow(data.date, seasonInfo.startDate, seasonInfo.endDate)) return;
    if (!regularDates.has(data.date)) return;
    const key = `${data.date}_${data.gameNum}`;
    games[key] = (games[key] || 0) + (data.count || 0);
  });

  let qualifyingGames = 0;
  for (const count of Object.values(games)) {
    if (count >= threshold) qualifyingGames++;
  }

  const calculatedPot = qualifyingGames * 10;

  const hhRef = db.collection('config').doc('highHands');
  const hhSnap = await hhRef.get();
  const current = (hhSnap.exists && hhSnap.data()[venue]) || null;

  const payload = {
    pot: String(calculatedPot),
    seasonId: seasonInfo.id || null,
    seasonNumber: seasonInfo.seasonNumber ?? null,
  };

  // Season rollover self-heal. The leader is a per-season title, so a leader
  // stamped with a PREVIOUS season is archived and the slot cleared — the board
  // then reads "No Current Leader" until someone actually qualifies this season.
  // Without this, last season's winner sat on the board indefinitely.
  if (current && current.player && seasonInfo.id && current.seasonId !== seasonInfo.id) {
    const history = Array.isArray(current.history) ? current.history.slice() : [];
    history.unshift({
      player: current.player,
      hand: current.hand || '',
      pot: current.pot || '0',
      seasonId: current.seasonId || null,
      seasonNumber: current.seasonNumber ?? null,
      timestamp: (current.updatedAt && current.updatedAt.toDate)
        ? current.updatedAt.toDate().toISOString()
        : new Date().toISOString(),
    });
    if (history.length > 20) history.length = 20;
    payload.player = '';
    payload.hand = '';
    payload.history = history;
    console.log(`High Hand: archived stale ${venue} leader "${current.player}" (season ${current.seasonNumber ?? '?'}) — live season is ${seasonInfo.seasonNumber ?? seasonInfo.id}.`);
  }

  await hhRef.set({ [venue]: payload }, { merge: true });

  console.log(`High Hand pot for ${venue}: $${calculatedPot} (${qualifyingGames} qualifying games, threshold ${threshold}).`);
  return calculatedPot;
}

/**
 * Manual recalc trigger — recomputes High Hand pot for both venues against
 * the active season. Run after data corrections or threshold changes.
 */
exports.recalculateHighHandPots = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const todayStr = appTodayStr(); // venue-local day, not UTC
  const results = {};
  for (const venue of ['Tight End', 'Wild Corgi']) {
    const season = await resolveSeasonForDate(venue, todayStr);
    if (!season) {
      results[venue] = { error: 'No active season found' };
      continue;
    }
    const pot = await updateHighHandPotForSeason(venue, season);
    results[venue] = { pot, season: season.name || season.id };
  }
  return { status: 'success', results };
});

exports.getHandOfNight = onCall(async (request) => {
  const { venue } = request.data || {};
  if (!venue) throw new HttpsError('invalid-argument', 'Venue required.');
  const doc = await db.collection('config').doc('handOfNight').get();
  const v = (doc.exists && doc.data()[venue]) ? doc.data()[venue] : null;
  return { success: true, hand: (v && v.hand) || '--', bonus: (v && v.bonus) || '---', theme: (v && v.theme) || '' };
});

exports.saveHandOfNight = onCall(async (request) => {
  await requireRole(request, ['staff']);
  const { venue, hand, bonus, theme } = request.data || {};
  if (!venue) throw new HttpsError('invalid-argument', 'Venue required.');
  await db.collection('config').doc('handOfNight').set({
    [venue]: { hand: hand || '--', bonus: bonus || '---', theme: theme || '', updatedAt: FieldValue.serverTimestamp() }
  }, { merge: true });
  return { status: 'success' };
});

exports.clearHandOfNight = onCall(async (request) => {
  await requireRole(request, ['staff']);
  const { venue } = request.data || {};
  if (!venue) throw new HttpsError('invalid-argument', 'Venue required.');
  await db.collection('config').doc('handOfNight').set({
    [venue]: { hand: '--', bonus: '---', theme: '', updatedAt: FieldValue.serverTimestamp() }
  }, { merge: true });
  return { status: 'success' };
});

function normalizeAnnouncementSourceUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';

  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function decodeMetaEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function extractMetaTagContent(html, selectors) {
  for (const selector of selectors) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeMetaEntities(match[1]);
    }
  }
  return '';
}

function extractHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeMetaEntities(match[1].replace(/\s+/g, ' ')) : '';
}

async function fetchAnnouncementLinkPreview(sourceUrl) {
  const normalizedUrl = normalizeAnnouncementSourceUrl(sourceUrl);
  if (!normalizedUrl) return { sourceUrl: '' };

  try {
    const fetch = (await import('node-fetch')).default;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(normalizedUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; AllInPokerBot/1.0; +https://poker-club.example)',
          accept: 'text/html,application/xhtml+xml'
        }
      });

      if (!response.ok) {
        return { sourceUrl: normalizedUrl };
      }

      const html = await response.text();
      const finalUrl = normalizeAnnouncementSourceUrl(response.url || normalizedUrl) || normalizedUrl;
      const title = extractMetaTagContent(html, ['og:title', 'twitter:title']) || extractHtmlTitle(html);
      const description = extractMetaTagContent(html, ['og:description', 'twitter:description', 'description']);
      const imageCandidate = extractMetaTagContent(html, ['og:image', 'twitter:image', 'twitter:image:src']);
      const siteName = extractMetaTagContent(html, ['og:site_name']);

      let imageUrl = '';
      if (imageCandidate) {
        try {
          imageUrl = new URL(imageCandidate, finalUrl).toString();
        } catch {
          imageUrl = '';
        }
      }

      let domain = '';
      try {
        domain = new URL(finalUrl).hostname.replace(/^www\./i, '');
      } catch {
        domain = '';
      }

      const preview = {
        sourceUrl: finalUrl,
        title,
        description,
        imageUrl,
        siteName,
        domain
      };

      return Object.fromEntries(
        Object.entries(preview).filter(([, value]) => Boolean(value))
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn('Announcement link preview skipped:', error.message);
    return { sourceUrl: normalizedUrl };
  }
}

async function buildAnnouncementMutation({ title, content, type = 'info', imageUrl = null, sourceUrl = null, removeImage = false, isUpdate = false }) {
  if (!title || !content) {
    throw new HttpsError('invalid-argument', 'Title and content are required.');
  }

  const docData = {
    title: title.trim(),
    content: content.trim(),
    type,
  };

  if (!isUpdate) {
    docData.createdAt = FieldValue.serverTimestamp();
    docData.status = 'published';
  } else {
    docData.updatedAt = FieldValue.serverTimestamp();
    docData.status = 'published';
  }

  if (removeImage) {
    docData.imageUrl = FieldValue.delete();
  } else if (imageUrl) {
    docData.imageUrl = imageUrl;
  }

  const preview = await fetchAnnouncementLinkPreview(sourceUrl);
  if (preview.sourceUrl) {
    docData.sourceUrl = preview.sourceUrl;
  } else if (isUpdate) {
    docData.sourceUrl = FieldValue.delete();
  }

  if (Object.keys(preview).some((key) => key !== 'sourceUrl')) {
    docData.linkPreview = preview;
  } else if (isUpdate) {
    docData.linkPreview = FieldValue.delete();
  }

  return docData;
}

exports.createAnnouncement = onCall(async (request) => {
  await requireRole(request, ['staff']);
  return doCreateAnnouncement(request.data || {});
});
async function doCreateAnnouncement(data) {
  const { title, content, type = 'info', imageUrl = null, sourceUrl = null } = data;

  const docData = await buildAnnouncementMutation({ title, content, type, imageUrl, sourceUrl });
  const docRef = await db.collection('announcements').add(docData);

  let push = { sent: 0, failed: 0, cleaned: 0 };
  try {
    push = await sendAnnouncementPush(docRef.id, docData);
  } catch (error) {
    console.error('Announcement push error (non-blocking):', error);
  }

  return { status: 'success', announcementId: docRef.id, push };
}

exports.updateAnnouncement = onCall(async (request) => {
  await requireRole(request, ['staff']);
  const { announcementId, title, content, type = 'info', imageUrl = null, sourceUrl = null, removeImage = false } = request.data || {};

  if (!announcementId) {
    throw new HttpsError('invalid-argument', 'announcementId is required.');
  }

  const docRef = db.collection('announcements').doc(String(announcementId));
  const existing = await docRef.get();
  if (!existing.exists) {
    throw new HttpsError('not-found', 'Announcement not found.');
  }

  const docData = await buildAnnouncementMutation({
    title,
    content,
    type,
    imageUrl,
    sourceUrl,
    removeImage,
    isUpdate: true
  });

  await docRef.set(docData, { merge: true });
  return { status: 'success', announcementId };
});

exports.deleteAnnouncement = onCall(async (request) => {
  await requireRole(request, ['staff']);
  const { announcementId } = request.data || {};

  if (!announcementId) {
    throw new HttpsError('invalid-argument', 'announcementId is required.');
  }

  const docRef = db.collection('announcements').doc(String(announcementId));
  const existing = await docRef.get();
  if (!existing.exists) {
    throw new HttpsError('not-found', 'Announcement not found.');
  }

  await docRef.set({
    status: 'deleted',
    deletedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return { status: 'success', announcementId };
});

// ===========================================
// GAMEDAY ANNOUNCEMENT (scheduled)
// ===========================================
//
// Replaces two crashing local "Claude routine" schedulers that used to run
// the poker-gameday-announcement/SKILL.md steps by hand. Runs DAILY and
// self-skips on non-game days — that also covers Big Stack/Championship
// nights landing on an unusual day of the week, so there's no separate
// "which nights" cron logic to maintain.

const GAMEDAY_GREETINGS = ['Poker People!', 'Poker Peoples!', 'Poker Peeps!', 'Poker Fam!'];

// Built-in gear description map, keyed by lowercased sanitized theme.
const GAMEDAY_GEAR_MAP = {
  'greenery': 'GREEN or PLANT/HERB inspired gear',
  'cowboys': 'WESTERN or COWBOY inspired gear',
  'casino royale': 'BLACK TIE or FORMAL inspired gear',
  'halloween': 'HALLOWEEN COSTUME or SPOOKY inspired gear'
};

// Sport theme words — CRITICAL: never generalize a sport theme to the bare
// word "sports" (e.g. Baseball must stay "baseball gear", not "sports gear").
const GAMEDAY_SPORT_WORDS = [
  'baseball', 'football', 'hockey', 'basketball', 'soccer', 'golf',
  'tennis', 'boxing', 'wrestling', 'rugby', 'cricket', 'volleyball',
  'lacrosse', 'softball'
];

function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function gamedayGreeting(date) {
  return GAMEDAY_GREETINGS[getISOWeekNumber(date) % 4];
}

// Strips a trailing "(placeholder)" marker and trims whitespace.
function sanitizeGamedayTheme(rawTheme) {
  return String(rawTheme || '').replace(/\(placeholder\)\s*$/i, '').trim();
}

function gamedayGearDescription(event, theme) {
  const custom = String(event?.gearDescription || '').trim();
  if (custom) return custom;

  const themeLower = String(theme || '').toLowerCase();
  if (GAMEDAY_GEAR_MAP[themeLower]) return GAMEDAY_GEAR_MAP[themeLower];

  const sport = GAMEDAY_SPORT_WORDS.find((word) => themeLower.includes(word));
  if (sport) {
    return `${sport} gear or the jersey/colors of your favorite ${sport} team`;
  }

  return theme ? `${theme} inspired gear` : 'theme inspired gear';
}

function isoDateFromUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Resolves today's venue-local (APP_TIMEZONE) calendar date regardless of the
 * host's runtime timezone (Cloud Functions run in UTC). Returns numeric parts.
 */
function getLocalDateParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/**
 * Pure template builder — no I/O, no Firestore, no clock reads beyond the
 * `now` argument. `now` must be a Date anchored to the target calendar day
 * (the scheduled function anchors it to 12:00 UTC to dodge DST edges). All
 * date math below uses UTC accessors so the output is identical no matter
 * what timezone the calling process happens to be running in.
 *
 * Returns { title, content, linkedEventDate } — linkedEventDate is the ISO
 * YYYY-MM-DD string the announcements feed matches against the schedule
 * collection to render the embedded event card.
 */
function buildGamedayAnnouncement(event = {}, now = new Date()) {
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const greeting = gamedayGreeting(now);

  const rawTheme = String(event.theme || '').trim();
  const sanitizedTheme = sanitizeGamedayTheme(rawTheme);
  const wasPlaceholder = /\(placeholder\)\s*$/i.test(rawTheme);
  // A theme that merely repeats the event type ("Championship" on a
  // Championship night) is a schedule-row filler, not a costume theme.
  const echoesType = sanitizedTheme.toLowerCase() === String(event.type || '').trim().toLowerCase();
  const themeIsReal = sanitizedTheme.length > 0 && !wasPlaceholder && !echoesType;

  const isBigStack = event.type === 'Big Stack';
  const isChampionship = event.type === 'Championship';
  const specialLine = isBigStack
    ? 'Tonight is our BIG STACK tournament! Show up by 6:50 to get your bonus.'
    : isChampionship
      ? 'Tonight is CHAMPIONSHIP NIGHT! Show up by 6:50 to get your bonus.'
      : null;

  let title;
  const bodyLines = [];

  if ((isBigStack || isChampionship) && !themeIsReal) {
    // No real theme set for the special-format night — pure Big
    // Stack/Championship copy, no gear/theme sentence.
    title = `${dayOfWeek} ${event.type}`;
    bodyLines.push(specialLine);
  } else {
    const themeForSentence = themeIsReal ? sanitizedTheme : (event.type || 'Poker Night');
    title = `${dayOfWeek} ${themeForSentence}`;
    const gearDescription = gamedayGearDescription(event, themeForSentence);
    bodyLines.push(
      `Tonight's theme is ${themeForSentence.toUpperCase()}, so wear your best ${gearDescription} and show up by 6:50 to receive your bonus.`
    );
    // The theme sentence already carries the 6:50 ask — append only the
    // short format callout, not the full line with a second 6:50 mention.
    if (isBigStack) bodyLines.push('Tonight is also our BIG STACK tournament!');
    else if (isChampionship) bodyLines.push('Tonight is also CHAMPIONSHIP NIGHT!');
  }

  // Optional one-off note (guest runners, schedule quirks, etc.) — its own
  // paragraph between the theme/format lines and the setup-help line.
  const note = String(event.announcementNote || '').trim();
  if (note) bodyLines.push(note);

  const content = [
    `Happy ${dayOfWeek} ${greeting}`,
    ...bodyLines,
    'Help setting up before 6:30 is always greatly appreciated and earns you an additional bonus.',
    'See you soon errrrbody 😁'
  ].join('\n\n');

  return { title, content, linkedEventDate: isoDateFromUTC(now) };
}

/**
 * Daily at 10:00 AM America/Denver. Self-skips when there's no scheduled
 * event today; also dedupes against an existing announcement already linked
 * to today's date so a redeploy/retry never double-posts.
 */
exports.gamedayAnnouncement = onSchedule({ schedule: '0 10 * * *', timeZone: 'America/Denver' }, async () => {
  const { year, month, day } = getLocalDateParts();
  const dateStr = `${month}/${day}/${year}`; // matches schedule doc `date` format, e.g. "7/14/2026"
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const isoDate = isoDateFromUTC(anchor);

  try {
    const scheduleSnap = await db.collection('schedule').get();
    const event = scheduleSnap.docs
      .map((docSnap) => docSnap.data())
      .find((e) => e.date === dateStr);

    if (!event) {
      console.log(`gamedayAnnouncement: no scheduled event for ${dateStr}; skipping.`);
      return;
    }

    const announcementsSnap = await db.collection('announcements').get();
    const alreadyPosted = announcementsSnap.docs.some((docSnap) => {
      const data = docSnap.data();
      return data.linkedEventDate === isoDate && data.status !== 'deleted';
    });

    if (alreadyPosted) {
      console.log(`gamedayAnnouncement: announcement already posted for ${isoDate}; skipping.`);
      return;
    }

    const { title, content, linkedEventDate } = buildGamedayAnnouncement(event, anchor);
    const docData = await buildAnnouncementMutation({ title, content, type: 'info' });
    docData.linkedEventDate = linkedEventDate;

    const docRef = await db.collection('announcements').add(docData);
    console.log(`gamedayAnnouncement: posted announcement ${docRef.id} for ${dateStr} at ${event.venue || event.location || 'unknown venue'}.`);

    try {
      await sendAnnouncementPush(docRef.id, docData);
    } catch (pushError) {
      console.error('gamedayAnnouncement: push failed (non-blocking):', pushError);
    }
  } catch (error) {
    console.error('gamedayAnnouncement: failed:', error);
  }
});

exports._test = {
  buildGamedayAnnouncement,
  getLocalDateParts,
  isoDateFromUTC,
  getISOWeekNumber,
  scanUnfinalizedGames
};

exports.logClientError = onCall(async (request) => {
  const data = request.data || {};

  const clamp = (value, max = 500) => String(value || '').slice(0, max);
  const scrubContext = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    const out = {};
    Object.entries(input).slice(0, 20).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (typeof value === 'string') out[key] = value.slice(0, 500);
      else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
      else out[key] = JSON.stringify(value).slice(0, 500);
    });
    return out;
  };

  try {
    await db.collection('clientErrors').add({
      source: clamp(data.source, 100) || 'unknown',
      page: clamp(data.page, 150),
      action: clamp(data.action, 150),
      message: clamp(data.message, 2000) || 'Unknown client error',
      code: clamp(data.code, 150),
      severity: ['warn', 'error'].includes(data.severity) ? data.severity : 'error',
      context: scrubContext(data.context),
      uid: request.auth?.uid || null,
      userAgent: clamp(request.rawRequest?.headers?.['user-agent'], 500),
      createdAt: FieldValue.serverTimestamp()
    });

    return { status: 'logged' };
  } catch (error) {
    console.error('logClientError failed:', error);
    return { status: 'failed' };
  }
});

// ===========================================
// DIAGNOSTIC - Player Points Audit
// ===========================================

/**
 * Audit exactly where a player's points are coming from.
 * Staff-only. Returns every raw record that contributes to their season total.
 */
exports.debugPlayerPoints = onCall(async (request) => {
  await requireRole(request, ['staff']);

  const { playerName, venue } = request.data;
  if (!playerName || !venue) {
    throw new HttpsError('invalid-argument', 'Missing playerName or venue');
  }

  const nameLower = playerName.trim().toLowerCase();

  // Resolve current season + effective window (same resolver as getLeaderboard)
  const resolved = await resolveSeasonForVenue(venue, null);
  const startDate = resolved.startDate;
  const endDate = resolved.endDate;
  const seasonName = resolved.seasonName;

  // Use the shared window check so this audit reports exactly what the
  // leaderboard counts (independent bounds, open-ended end supported).
  function inSeason(dateStr) {
    return isInSeasonWindow(dateStr, startDate, endDate);
  }

  function calcPoints(data) {
    if (data.totalPoints !== undefined && data.totalPoints !== null) {
      return { points: data.totalPoints, method: 'totalPoints field' };
    }
    if (data.bonusPoints !== undefined && data.bonusPoints !== null) {
      return { points: data.bonusPoints + ATTENDANCE_POINTS, method: `bonusPoints(${data.bonusPoints}) + attendance(${ATTENDANCE_POINTS})` };
    }
    if (data.rank !== undefined && data.rank !== null) {
      if (data.rank > 10) {
        return { points: data.rank, method: `old format: rank field as total (${data.rank})` };
      }
      const bp = (BONUS_POINTS[data.rank] || 0) + ATTENDANCE_POINTS;
      return { points: bp, method: `old format: BONUS_POINTS[${data.rank}](${BONUS_POINTS[data.rank] || 0}) + attendance(${ATTENDANCE_POINTS})` };
    }
    return { points: 0, method: 'no points fields found' };
  }

  // Query eliminations — match on playerLower if available, else scan
  const elimSnap = await db.collection('eliminations').where('venue', '==', venue).get();
  const elimRecords = [];
  let elimTotal = 0;

  elimSnap.docs.forEach(doc => {
    const d = doc.data();
    const pLower = (d.playerLower || d.player || '').toLowerCase();
    if (pLower !== nameLower) return;
    if (d.status === 'removed') return;
    if (!isSeasonEligibleGameType(d.gameType)) return;
    if (!inSeason(d.date)) return;

    const { points, method } = calcPoints(d);
    elimTotal += points;
    elimRecords.push({
      docId: doc.id,
      date: d.date,
      gameNum: d.gameNum,
      rank: d.rank,
      bonusPoints: d.bonusPoints ?? null,
      totalPoints: d.totalPoints ?? null,
      status: d.status,
      gameType: d.gameType || 'Regular',
      numTied: d.numTied ?? null,
      syncedToGAS: d.syncedToGAS ?? null,
      pointsAdded: points,
      calcMethod: method,
      createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null,
      processedAt: d.processedAt ? d.processedAt.toDate().toISOString() : null,
    });
  });

  // Query attendance-only checkins
  const checkinSnap = await db.collection('checkins')
    .where('venue', '==', venue)
    .where('attendanceOnly', '==', true)
    .get();
  const checkinRecords = [];
  let checkinTotal = 0;

  checkinSnap.docs.forEach(doc => {
    const d = doc.data();
    const pLower = (d.playerLower || d.player || '').toLowerCase();
    if (pLower !== nameLower) return;
    if (d.status === 'removed') return;
    if (!inSeason(d.date)) return;

    checkinTotal += ATTENDANCE_POINTS;
    checkinRecords.push({
      docId: doc.id,
      date: d.date,
      gameNum: d.gameNum,
      status: d.status,
      gameType: d.gameType || 'Regular',
      attendanceOnly: d.attendanceOnly,
      pointsAdded: ATTENDANCE_POINTS,
      createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null,
      processedAt: d.processedAt ? d.processedAt.toDate().toISOString() : null,
    });
  });

  // Also pull ALL checkins for this player (not just attendanceOnly) so we can spot issues
  const allCheckinSnap = await db.collection('checkins').where('venue', '==', venue).get();
  const allCheckins = [];
  allCheckinSnap.docs.forEach(doc => {
    const d = doc.data();
    const pLower = (d.playerLower || d.player || '').toLowerCase();
    if (pLower !== nameLower) return;
    if (!inSeason(d.date)) return;
    allCheckins.push({
      docId: doc.id,
      date: d.date,
      gameNum: d.gameNum,
      status: d.status,
      attendanceOnly: d.attendanceOnly ?? false,
      gameType: d.gameType || 'Regular',
      createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null,
    });
  });

  const grandTotal = elimTotal + checkinTotal;

  return {
    status: 'success',
    playerName: playerName.trim(),
    venue,
    season: { name: seasonName, startDate, endDate },
    grandTotal,
    elimTotal,
    checkinTotal,
    eliminations: elimRecords.sort((a, b) => a.date.localeCompare(b.date) || a.gameNum - b.gameNum),
    attendanceCheckins: checkinRecords.sort((a, b) => a.date.localeCompare(b.date) || a.gameNum - b.gameNum),
    allCheckins: allCheckins.sort((a, b) => a.date.localeCompare(b.date) || a.gameNum - b.gameNum),
  };
});

/**
 * Batch season audit — computes what getLeaderboard would score for EVERY player
 * in the season and returns a diff against the current live standings.
 * Read-only. No writes. Admin-only.
 *
 * Returns:
 *   players[] — { name, livePoints, auditPoints, delta, reasons[] }
 *   changed[]  — subset where delta !== 0
 *   excluded[] — records dropped by the new rules, grouped by reason
 */
exports.auditSeasonPoints = onCall(async (request) => {
  await requireRole(request, ['admin']);
  const { venue, seasonId } = request.data;
  if (!venue) throw new HttpsError('invalid-argument', 'Missing venue');

  try {
    // ── 1. Resolve season bounds (shared resolver — endDate may be derived) ────
    const resolved = await resolveSeasonForVenue(venue, seasonId);
    const startDate = resolved.startDate;
    const endDate = resolved.endDate;
    const seasonName = resolved.seasonName;
    const seasonNumber = resolved.seasonNumber;
    if (!startDate) throw new HttpsError('not-found', `No season found for venue: ${venue}`);

    const seasonInfo = { venue, startDate, endDate, seasonNumber };

    // ── 2. Fetch the current live leaderboard for comparison ──────────────────
    const liveLeaderboard = {};
    try {
      const liveSnap = await db.collection('seasons')
        .where('venue', '==', venue).get(); // we just need the shape; call getLeaderboard logic inline
    } catch (_) { /* handled below */ }

    // ── 3. Recompute standings using the FIXED rules (mirror of getLeaderboard) ─
    const auditStats = {};   // name → { points, gamesPlayed, wins, games:Set }
    const auditElimKeys = {}; // pLower → Set<gameKey>
    const excluded = [];     // { docId, player, date, gameType, reason }

    // Eliminations
    const elimSnap = await db.collection('eliminations').where('venue', '==', venue).get();
    elimSnap.docs.forEach(doc => {
      const d = doc.data();
      if (d.status === 'removed') return;
      if (!isSeasonEligibleGameType(d.gameType)) return;

      if (!isInSeasonWindow(d.date, startDate, endDate)) {
        excluded.push({ docId: doc.id, collection: 'eliminations', player: d.player, date: d.date, gameType: d.gameType, reason: 'date outside season window' });
        return;
      }
      if (d.season !== undefined && d.season !== null
          && seasonNumber !== undefined && seasonNumber !== null
          && Number(d.season) !== Number(seasonNumber)) {
        excluded.push({ docId: doc.id, collection: 'eliminations', player: d.player, date: d.date, season: d.season, reason: `season mismatch (record:${d.season} season:${seasonNumber})` });
        return;
      }

      const player = d.player; if (!player) return;
      const gameKey = `${d.date}-${d.gameNum}`;
      const pLower = d.playerLower || player.toLowerCase();
      if (!auditElimKeys[pLower]) auditElimKeys[pLower] = new Set();
      auditElimKeys[pLower].add(gameKey);

      if (!auditStats[player]) auditStats[player] = { points: 0, gamesPlayed: 0, wins: 0, games: new Set() };

      let pts = 0, isWin = false;
      if (d.totalPoints !== undefined && d.totalPoints !== null) { pts = d.totalPoints; isWin = d.rank === 1; }
      else if (d.bonusPoints !== undefined && d.bonusPoints !== null) { pts = d.bonusPoints + ATTENDANCE_POINTS; isWin = d.rank === 1 || d.bonusPoints === 90; }
      else if (d.rank !== undefined && d.rank !== null) {
        pts = d.rank > 10 ? d.rank : (BONUS_POINTS[d.rank] || 0) + ATTENDANCE_POINTS;
        isWin = d.rank === 1;
      }
      auditStats[player].points += pts;
      if (!auditStats[player].games.has(gameKey)) { auditStats[player].games.add(gameKey); auditStats[player].gamesPlayed++; }
      if (isWin) auditStats[player].wins++;
    });

    // Bounties
    const bountySnap = await db.collection('bounties').where('venue', '==', venue).get();
    const seenB = new Set();
    bountySnap.docs.forEach(doc => {
      const d = doc.data();
      if (d.status === 'removed') return;
      const bk = `${(d.player || '').toLowerCase()}|${d.date}|${d.gameNum}`;
      if (seenB.has(bk)) return; seenB.add(bk);
      if (!isInSeasonWindow(d.date, startDate, endDate)) {
        excluded.push({ docId: doc.id, collection: 'bounties', player: d.player, date: d.date, reason: 'date outside season window' });
        return;
      }
      if (d.season !== undefined && d.season !== null
          && seasonNumber !== undefined && seasonNumber !== null
          && Number(d.season) !== Number(seasonNumber)) {
        excluded.push({ docId: doc.id, collection: 'bounties', player: d.player, date: d.date, season: d.season, reason: `season mismatch (record:${d.season} season:${seasonNumber})` });
        return;
      }
      const player = d.player; if (!player) return;
      if (!auditStats[player]) auditStats[player] = { points: 0, gamesPlayed: 0, wins: 0, games: new Set() };
      auditStats[player].bounties = (auditStats[player].bounties || 0) + (d.count || 0);
    });

    // Attendance-only checkins
    const checkinSnap = await db.collection('checkins')
      .where('venue', '==', venue)
      .where('attendanceOnly', '==', true)
      .get();
    checkinSnap.docs.forEach(doc => {
      const d = doc.data();
      const player = d.player; if (!player) return;
      const gameKey = `${d.date}-${d.gameNum}`;
      const pLower = d.playerLower || player.toLowerCase();
      const hasElim = !!(auditElimKeys[pLower] && auditElimKeys[pLower].has(gameKey));

      if (!isSeasonAttendanceEligible(d, seasonInfo, hasElim)) {
        let reason = 'failed eligibility check';
        if (d.status === 'removed') reason = 'status=removed';
        else if (!isSeasonEligibleGameType(d.gameType)) reason = `non-season gameType (${d.gameType || 'null'})`;
        else if (!isInSeasonWindow(d.date, startDate, endDate)) reason = 'date outside season window';
        else if (d.season !== undefined && d.season !== null && seasonNumber !== null && Number(d.season) !== Number(seasonNumber)) reason = `season mismatch (record:${d.season} season:${seasonNumber})`;
        else if (hasElim) reason = 'player has elimination for same game';
        excluded.push({ docId: doc.id, collection: 'checkins', player, date: d.date, gameType: d.gameType, season: d.season, reason });
        return;
      }

      if (!auditStats[player]) auditStats[player] = { points: 0, gamesPlayed: 0, wins: 0, games: new Set() };
      auditStats[player].points += ATTENDANCE_POINTS;
      if (!auditStats[player].games.has(gameKey)) { auditStats[player].games.add(gameKey); auditStats[player].gamesPlayed++; }
    });

    // ── 4. Fetch live leaderboard standings ───────────────────────────────────
    // Call getLeaderboard logic directly to get the currently-displayed numbers.
    // We reproduce only the point-total portion to keep the audit self-contained.
    const liveStats = {};
    {
      const elimL = await db.collection('eliminations').where('venue', '==', venue).get();
      elimL.docs.forEach(doc => {
        const d = doc.data();
        if (d.status === 'removed') return;
        if (!isSeasonEligibleGameType(d.gameType)) return;
        // OLD (broken) filter — intentionally reproducing the pre-fix logic to show what was scored
        if (startDate && endDate) {
          const docDate = new Date(d.date);
          if (docDate < new Date(startDate) || docDate > new Date(endDate)) return;
        }
        const player = d.player; if (!player) return;
        if (!liveStats[player]) liveStats[player] = { points: 0 };
        let pts = 0;
        if (d.totalPoints !== undefined && d.totalPoints !== null) pts = d.totalPoints;
        else if (d.bonusPoints !== undefined && d.bonusPoints !== null) pts = d.bonusPoints + ATTENDANCE_POINTS;
        else if (d.rank !== undefined && d.rank !== null) pts = d.rank > 10 ? d.rank : (BONUS_POINTS[d.rank] || 0) + ATTENDANCE_POINTS;
        liveStats[player].points += pts;
      });

      const checkinL = await db.collection('checkins')
        .where('venue', '==', venue).where('attendanceOnly', '==', true).get();
      checkinL.docs.forEach(doc => {
        const d = doc.data();
        if (d.status === 'removed') return;
        if (startDate && endDate) {
          const docDate = new Date(d.date);
          if (docDate < new Date(startDate) || docDate > new Date(endDate)) return;
        }
        const player = d.player; if (!player) return;
        if (!liveStats[player]) liveStats[player] = { points: 0 };
        liveStats[player].points += ATTENDANCE_POINTS;
      });
    }

    // ── 5. Produce diff ───────────────────────────────────────────────────────
    const allPlayers = new Set([...Object.keys(auditStats), ...Object.keys(liveStats)]);
    const players = Array.from(allPlayers).map(name => {
      const live = (liveStats[name] || {}).points || 0;
      const audit = (auditStats[name] || {}).points || 0;
      return { name, livePoints: live, auditPoints: audit, delta: audit - live };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.livePoints - a.livePoints);

    const changed = players.filter(p => p.delta !== 0);

    return {
      status: 'success',
      venue,
      season: { name: seasonName, startDate, endDate, seasonNumber },
      players,
      changed,
      excludedCount: excluded.length,
      excluded: excluded.sort((a, b) => (a.player || '').localeCompare(b.player || '')),
    };

  } catch (err) {
    console.error('auditSeasonPoints error:', err);
    throw new HttpsError('internal', err.message);
  }
});

// ===========================================
// SEASON RESOLUTION HELPERS
// ===========================================
// (The scoringEvents "canonical scoring layer" that used to live here was
// removed 2026-09-05: written on every finalize since Season 27, never read.)

/**
 * Resolve which season a given date belongs to for a venue.
 * Returns season metadata object or null if no match.
 */
async function resolveSeasonForDate(venue, dateStr) {
  const d = parseGameDate(dateStr);
  if (!d) return null;
  const snap = await db.collection('seasons').where('venue', '==', venue).get();
  const venueSeasons = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  let match = null;
  venueSeasons.forEach(s => {
    const start = parseGameDate(s.startDate);
    if (!start || d < start) return;
    // endDate is OPTIONAL — an open season runs until the next one starts, and
    // forever if nothing is booted after it (see resolveSeasonEnd). Requiring an
    // explicit endDate here returned null for every LIVE season, which silently
    // (a) froze the High Hand pot at the last closed season's value and
    // (b) stamped seasonNumber:null onto every scoringEvent of the live season.
    const { endDate } = resolveSeasonEnd(s, venueSeasons);
    const end = parseGameDate(endDate);
    if (end && d > end) return;
    if (!match || start > parseGameDate(match.startDate)) {
      match = {
        id: s.id,
        seasonNumber: s.seasonNumber ?? null,
        name: s.name || '',
        startDate: s.startDate,
        endDate: endDate || null,
      };
    }
  });
  return match;
}

// ===========================================
// SUBMISSION RECONCILIATION (preview + audit)
// ===========================================
// Shared between finalizeGame and previewGameSubmission so the director's
// pre-submit "looks full / partial" report is computed from EXACTLY the same
// records finalize will act on. loadGameRecords is the single source of the
// three raw queries; buildSubmissionReport is a pure function of those snaps.

/**
 * Load the three raw collections a game finalize touches, with the exact
 * filters finalizeGame uses. Returns the Firestore query snapshots.
 */
async function loadGameRecords(normalizedDate, gameNum, venue, opts = {}) {
  const gn = parseInt(gameNum);
  // finalize loads only 'active' records (what it will process). The review tool
  // passes includeProcessed so an already-/partially-finalized game reconciles its
  // FULL recorded state — e.g. bounties already finalized still show and count
  // instead of reading as 0. 'removed' overwrite-history is filtered downstream.
  const includeProcessed = opts.includeProcessed === true;
  const elimBase = db.collection('eliminations')
    .where('date', '==', normalizedDate)
    .where('gameNum', '==', gn)
    .where('venue', '==', venue);
  const bountyBase = db.collection('bounties')
    .where('date', '==', normalizedDate)
    .where('gameNum', '==', gn)
    .where('venue', '==', venue);
  const [elimsSnap, bountiesSnap, checkinsSnap] = await Promise.all([
    (includeProcessed ? elimBase : elimBase.where('status', '==', 'active')).get(),
    (includeProcessed ? bountyBase : bountyBase.where('status', '==', 'active')).get(),
    // checkins: no status filter (removed skipped per-doc); same for both callers.
    db.collection('checkins')
      .where('date', '==', normalizedDate)
      .where('gameNum', '==', gn)
      .where('venue', '==', venue)
      .get()
  ]);
  return { elimsSnap, bountiesSnap, checkinsSnap };
}

/** Normalized lowercase player key, mirroring finalize's playerLower fallback. */
function playerKey(data) {
  return data.playerLower || (data.player || '').toLowerCase();
}

/** "4th", "1st", etc. (server-side; mirrors getOrdinalSuffix in director.html). */
function ordinalLabel(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/**
 * Pure reconciliation: given the loaded snapshots (plus optional rsvps + season),
 * compute the FULL/PARTIAL/BLOCK verdict, counts, per-player placements, warnings,
 * and the supporting name lists. No reads, no writes.
 */
function buildSubmissionReport(snaps, ctx) {
  const { elimsSnap, bountiesSnap, checkinsSnap, rsvpsSnap } = snaps;
  const { gameNum, season } = ctx;
  const gn = parseInt(gameNum);

  // Exclude 'removed' overwrite-history; keep active + already-'processed' so the
  // review reflects the full recorded game. finalize passes active-only snaps, so
  // these filters are a no-op there.
  const elimDocs = elimsSnap.docs.filter(d => d.data().status !== 'removed');
  const bountyDocs = bountiesSnap.docs.filter(d => d.data().status !== 'removed');
  const checkinDocs = checkinsSnap.docs;
  const rsvpDocs = rsvpsSnap ? rsvpsSnap.docs : [];

  const gameType = elimDocs.length ? (elimDocs[0].data().gameType || 'Regular') : 'Regular';
  const typeSet = new Set(elimDocs.map(d => d.data().gameType || 'Regular'));
  const mixedGameType = typeSet.size > 1;
  const eligibleForSeason = isSeasonEligibleGameType(gameType);

  const activeCheckins = checkinDocs.filter(d => d.data().status !== 'removed');
  const removedCheckins = checkinDocs.filter(d => d.data().status === 'removed');
  const checkinKeys = new Set(activeCheckins.map(d => playerKey(d.data())));
  const placedKeys = new Set(elimDocs.map(d => playerKey(d.data())));

  // Tie groups + per-player placements (richer than finalize's return: ALL placers)
  const byRank = {};
  elimDocs.forEach(d => {
    const r = d.data().rank;
    (byRank[r] = byRank[r] || []).push(d);
  });
  const placements = [];
  const tieGroups = [];
  Object.keys(byRank).forEach(rk => {
    const docs = byRank[rk];
    const rank = parseInt(rk);
    const numTied = docs.length;
    const bonusPoints = calculateTiePoints(rank, numTied);
    if (numTied > 1) {
      tieGroups.push({ rank, numTied, bonusPoints, players: docs.map(d => d.data().player) });
    }
    docs.forEach(d => {
      const data = d.data();
      placements.push({
        player: data.player,
        playerLower: playerKey(data),
        rank,
        bonusPoints,
        numTied,
        checkedIn: checkinKeys.has(playerKey(data))
      });
    });
  });
  placements.sort((a, b) => a.rank - b.rank || String(a.player).localeCompare(String(b.player)));

  // Attendance-only (what finalize WILL flag): active checkins not in placed set
  const attendanceOnlyPlayers = activeCheckins
    .filter(d => !placedKeys.has(playerKey(d.data())))
    .map(d => d.data().player);

  // Placed but never checked in (legitimate manual rank entry; soft warn)
  const placedNotCheckedIn = elimDocs
    .filter(d => !checkinKeys.has(playerKey(d.data())))
    .map(d => d.data().player);

  // Rank-hole scan, tie-window aware (a tie at k with N fills only rank k)
  const filledRanks = new Set(elimDocs.map(d => d.data().rank));
  const maxRank = elimDocs.length ? Math.max(...elimDocs.map(d => d.data().rank)) : 0;
  const coveredByTie = new Set();
  Object.keys(byRank).forEach(rk => {
    const rank = parseInt(rk);
    const numTied = byRank[rk].length;
    for (let r = rank; r < rank + numTied; r++) coveredByTie.add(r);
  });
  const holeRanks = [];
  for (let r = 1; r <= maxRank; r++) {
    if (!filledRanks.has(r) && !coveredByTie.has(r)) holeRanks.push(r);
  }

  // Duplicate eliminations (same player, >1 active elim => double bonus)
  const elimRanksByKey = {};
  elimDocs.forEach(d => {
    const k = playerKey(d.data());
    (elimRanksByKey[k] = elimRanksByKey[k] || []).push(d.data().rank);
  });
  const duplicateEliminations = Object.keys(elimRanksByKey)
    .filter(k => elimRanksByKey[k].length > 1)
    .map(k => ({ player: k, ranks: elimRanksByKey[k] }));

  // Duplicate bounty docs (counts get summed)
  const bountyDocCountByKey = {};
  bountyDocs.forEach(d => {
    const k = playerKey(d.data());
    bountyDocCountByKey[k] = (bountyDocCountByKey[k] || 0) + 1;
  });
  const duplicateBounties = Object.keys(bountyDocCountByKey)
    .filter(k => bountyDocCountByKey[k] > 1)
    .map(k => ({ player: k, docCount: bountyDocCountByKey[k] }));

  // Phantom bounty: bounty for someone with no checkin and no placement
  const phantomBounties = bountyDocs
    .filter(d => {
      const k = playerKey(d.data());
      return !checkinKeys.has(k) && !placedKeys.has(k);
    })
    .map(d => d.data().player);

  // Removed-but-placed contradiction (corruption).
  //
  // Only a player with NO surviving active check-in is a real contradiction.
  // checkInPlayer ALWAYS adds a new doc rather than restoring the removed one, so
  // an ordinary remove-then-re-add leaves a 'removed' doc sitting beside the new
  // 'active' one. Matching on removed docs alone made that routine correction look
  // like corruption and hard-BLOCKED finalize with no override — and each re-add
  // the director tried appended another removed doc instead of clearing the flag,
  // so the game could never be closed out (8/27 Wild Corgi G1, Jonathan Kiersky).
  // Dedup by name: N removed docs for one player is still one player.
  const removedButPlaced = [...new Set(
    removedCheckins
      .filter(d => {
        const k = playerKey(d.data());
        return placedKeys.has(k) && !checkinKeys.has(k);
      })
      .map(d => d.data().player)
  )];

  // Stale attendance flags (re-finalize info): active checkin already flagged
  // attendanceOnly whose player is now a placer (finalize will clear it).
  const staleAttendanceFlags = activeCheckins
    .filter(d => d.data().attendanceOnly === true && placedKeys.has(playerKey(d.data())))
    .length;

  // Unconverted RSVPs (advisory; the one collection finalize doesn't read)
  const rsvpUnconvertedPlayers = rsvpDocs
    .filter(d => {
      const data = d.data();
      if (data.status === 'removed') return false;
      if (parseInt(data.gameNum) !== gn) return false;
      return !checkinKeys.has(playerKey(data));
    })
    .map(d => d.data().player);

  const checkedInCount = activeCheckins.length;
  const placedCount = elimDocs.length;
  const ranksFilledCount = filledRanks.size;
  const expectedRanks = Math.min(10, checkedInCount);
  const attendanceOnlyCount = attendanceOnlyPlayers.length;
  const bountyTotal = bountyDocs.reduce((s, d) => s + (d.data().count || 0), 0);
  const bountyPlayers = bountyDocs.length;

  const warnings = [];
  // --- errors (=> BLOCK) ---
  if (placedCount === 0) {
    warnings.push({ id: 'W_NO_ELIMS', severity: 'error', message: 'No eliminations recorded — there is nothing to finalize.' });
  }
  if (holeRanks.length) {
    warnings.push({ id: 'W_RANK_HOLE', severity: 'error', message: `Missing ${holeRanks.map(ordinalLabel).join(', ')} place — the rank order has a gap. Enter the missing place(s) before finalizing.` });
  }
  if (removedButPlaced.length) {
    warnings.push({ id: 'W_REMOVED_PLACED', severity: 'error', message: `${removedButPlaced.join(', ')} removed from check-in but still has a recorded placement. Fix before finalizing.` });
  }
  if (duplicateEliminations.length) {
    warnings.push({ id: 'W_DUP_ELIM', severity: 'error', message: `${duplicateEliminations.map(d => d.player).join(', ')} has more than one elimination — points would be double-counted. Remove the extra.` });
  }
  // --- warns (=> PARTIAL) ---
  // "Places filled" counts PLACERS (tie-aware): two players sharing a rank still
  // fill two finishing positions, so a complete field with a tie is NOT incomplete.
  if (placedCount > 0 && holeRanks.length === 0 && placedCount < expectedRanks) {
    warnings.push({ id: 'W_INCOMPLETE_TOP', severity: 'warn', message: `Only ${placedCount} of ${expectedRanks} places filled. If the game is over, enter the rest before you finalize.` });
  }
  if (attendanceOnlyCount === 0 && checkedInCount > 0 && checkedInCount === placedCount) {
    warnings.push({ id: 'W_NO_ATTENDANCE', severity: 'warn', message: 'Every checked-in player placed — no attendance-only players. If others attended, their check-ins may be missing.' });
  }
  if (placedNotCheckedIn.length) {
    warnings.push({ id: 'W_PLACED_NOT_CHECKEDIN', severity: 'warn', message: `${placedNotCheckedIn.join(', ')} placed but never checked in. They will still score; verify the name matches the master list.` });
  }
  if (rsvpUnconvertedPlayers.length) {
    warnings.push({ id: 'W_RSVP_UNCONVERTED', severity: 'warn', message: `${rsvpUnconvertedPlayers.length} RSVP(s) never checked in: ${rsvpUnconvertedPlayers.join(', ')}. They will receive no points for this game.` });
  }
  if (duplicateBounties.length) {
    warnings.push({ id: 'W_DUP_BOUNTY', severity: 'warn', message: `Duplicate bounty entries for ${duplicateBounties.map(d => d.player).join(', ')} — counts will be added together. Confirm the total is right.` });
  }
  if (phantomBounties.length) {
    warnings.push({ id: 'W_PHANTOM_BOUNTY', severity: 'warn', message: `Bounty recorded for ${phantomBounties.join(', ')} who has no check-in and no placement. Confirm the name.` });
  }
  if (mixedGameType) {
    warnings.push({ id: 'W_MIXED_TYPE', severity: 'warn', message: `Eliminations have mixed game types (${[...typeSet].join(', ')}); finalize will treat the whole game as ${gameType}.` });
  }
  // --- info (never affects verdict) ---
  tieGroups.forEach(t => {
    warnings.push({ id: 'W_TIE_INFO', severity: 'info', message: `Tie at ${ordinalLabel(t.rank)}: ${t.players.join(' & ')} — ${t.bonusPoints} pts each.` });
  });

  const hasError = warnings.some(w => w.severity === 'error');
  const hasWarn = warnings.some(w => w.severity === 'warn');
  const verdict = hasError ? 'BLOCK' : (hasWarn ? 'PARTIAL' : 'FULL');

  if (verdict === 'FULL' && attendanceOnlyCount > 0) {
    warnings.push({ id: 'W_ATTENDANCE_NORMAL', severity: 'info', message: `${attendanceOnlyCount} attendance-only player(s) (checked in, didn't final-table). Normal for a full field.` });
  }
  if (!eligibleForSeason) {
    const sn = season && season.seasonNumber != null ? season.seasonNumber : null;
    warnings.push({ id: 'W_NON_REGULAR_TYPE', severity: 'info', message: `This is a ${gameType} game — points will NOT count toward ${sn != null ? 'Season ' + sn : 'season'} standings.` });
  }
  if (staleAttendanceFlags > 0) {
    warnings.push({ id: 'W_STALE_FLAGS', severity: 'info', message: `Re-finalize detected: ${staleAttendanceFlags} stale attendance-only flag(s) will be corrected during this finalize.` });
  }
  // Reassure on a re-finalize: records already finalized are counted here and
  // need no re-entry (info only — never a warning, never blocks).
  const processedElims = elimDocs.filter(d => d.data().status === 'processed').length;
  const processedBounties = bountyDocs.filter(d => d.data().status === 'processed').length;
  if (processedElims > 0 || processedBounties > 0) {
    const parts = [];
    if (processedElims > 0) parts.push(`${processedElims} placement${processedElims === 1 ? '' : 's'}`);
    if (processedBounties > 0) parts.push(`${processedBounties} bounty entr${processedBounties === 1 ? 'y' : 'ies'}`);
    warnings.push({ id: 'W_ALREADY_FINALIZED', severity: 'info', message: `${parts.join(' and ')} were already finalized previously — already counted, no need to re-enter.` });
  }

  const sevRank = { error: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  return {
    verdict,
    gameType,
    mixedGameType,
    eligibleForSeason,
    season: season ? { number: season.seasonNumber ?? null, name: season.name || '' } : null,
    counts: {
      checkedIn: checkedInCount,
      removedCheckins: removedCheckins.length,
      placed: placedCount,
      // "Placed" tile value: positions filled (tie-aware) = placers, so a complete
      // field with a tie reads 10/10 not 9/10.
      ranksFilled: placedCount,
      expectedRanks,
      attendanceOnly: attendanceOnlyCount,
      bountyPlayers,
      bountyTotal,
      rsvpUnconverted: rsvpUnconvertedPlayers.length
    },
    placements,
    tieGroups,
    details: {
      attendanceOnlyPlayers,
      placedNotCheckedIn,
      rsvpUnconvertedPlayers,
      holeRanks,
      duplicateEliminations,
      duplicateBounties,
      phantomBounties,
      removedButPlaced,
      staleAttendanceFlags
    },
    warnings
  };
}

/** Read-only rsvps load for the advisory unconverted-RSVP warning. Never throws. */
async function loadRsvpsForGame(normalizedDate, venue) {
  try {
    return await db.collection('rsvps')
      .where('date', '==', normalizedDate)
      .where('venue', '==', venue)
      .where('status', '==', 'active')
      .get();
  } catch (e) {
    return null;
  }
}

function getPublicAppBaseUrl() {
  return process.env.PUBLIC_APP_BASE_URL || 'https://poker-club.example';
}

async function sendAnnouncementPush(announcementId, announcement) {
  const title = String(announcement?.title || '').trim();
  if (!title) return { sent: 0, failed: 0, cleaned: 0 };

  const subscriberSnap = await db.collection('userProfiles')
    .where('preferences.announcements', '==', true)
    .where('preferences.push', '==', true)
    .get();

  const tokenOwners = new Map();
  subscriberSnap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const tokens = Array.isArray(data.pushTokens) ? data.pushTokens : [];
    tokens.forEach((token) => {
      if (!token) return;
      if (!tokenOwners.has(token)) tokenOwners.set(token, new Set());
      tokenOwners.get(token).add(docSnap.id);
    });
  });

  const tokens = [...tokenOwners.keys()];
  if (!tokens.length) return { sent: 0, failed: 0, cleaned: 0 };

  const appBaseUrl = getPublicAppBaseUrl();
  const link = `${appBaseUrl}/announcements.html?announcement=${announcementId}`;
  const body = 'Tap to read the latest league announcement.';

  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title,
      body
    },
    data: {
      announcementId,
      url: link
    },
    android: {
      priority: 'high',
      notification: {
        clickAction: 'OPEN_ANNOUNCEMENTS'
      }
    },
    webpush: {
      fcmOptions: {
        link
      },
      notification: {
        title,
        body,
        icon: `${appBaseUrl}/img/app-icon-192.png`,
        badge: `${appBaseUrl}/img/favicon-32.png`,
        tag: `announcement-${announcementId}`,
        data: {
          url: link
        }
      }
    }
  });

  const invalidTokens = [];
  response.responses.forEach((res, index) => {
    if (res.success) return;
    const code = res.error?.code || '';
    if (code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token') {
      invalidTokens.push(tokens[index]);
    }
  });

  if (invalidTokens.length) {
    const ownerUpdates = new Map();
    invalidTokens.forEach((token) => {
      const owners = tokenOwners.get(token) || new Set();
      owners.forEach((uid) => {
        if (!ownerUpdates.has(uid)) ownerUpdates.set(uid, []);
        ownerUpdates.get(uid).push(token);
      });
    });

    await Promise.all(
      [...ownerUpdates.entries()].map(([uid, userTokens]) =>
        db.collection('userProfiles').doc(uid).set({
          pushTokens: FieldValue.arrayRemove(...userTokens),
          pushTokenUpdatedAt: FieldValue.serverTimestamp()
        }, { merge: true })
      )
    );
  }

  return {
    sent: response.successCount,
    failed: response.failureCount,
    cleaned: invalidTokens.length
  };
}

// ===========================================
// UNFINALIZED GAME SWEEP
// ===========================================
//
// A game night that never got finalized is invisible. The check-ins sit at
// status 'active', nobody's points move, and nothing in the app complains.
// Tight End 8/11/2026 G2 and Wild Corgi 8/20/2026 G2 both sat that way for up
// to two weeks before a manual audit caught them — 69 players uncredited.
//
// This sweep asks "did every past game night actually get scored?" once a day
// and parks the answer where staff will see it.
//
// Two distinct failure modes, because they need different fixes:
//   NEVER_SCORED   check-ins exist, zero eliminations. Nobody opened Director
//                  Mode for that game at all — the results still have to be
//                  reconstructed from paper or memory.
//   NOT_FINALIZED  eliminations exist but none are 'processed'. The director
//                  typed the results in and never hit Finalize. The data is
//                  already there; it just needs submitting.
//
// Only Regular games are scanned. Big Stack and Championship nights score
// through a different flow and legitimately carry zero eliminations in this
// collection — including them would flag every one of them, every day, which
// is how an alert trains people to ignore it.

// 90 days ~= one and a half seasons. The scan reads the whole checkins and
// eliminations collections either way, so a wider window costs nothing extra —
// and a 30-day window would have missed Tight End 7/7/2026 G1, which sat
// unfinalized for 49 days through a season close, a championship and a venue report.
const UNFINALIZED_LOOKBACK_DAYS = 90;

async function scanUnfinalizedGames(lookbackDays = UNFINALIZED_LOOKBACK_DAYS) {
  const today = appToday();
  const earliest = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const scheduleSnap = await db.collection('schedule').get();
  const candidates = [];
  scheduleSnap.forEach((docSnap) => {
    const s = docSnap.data();
    const type = (s.type === undefined || s.type === null || s.type === '')
      ? 'Regular' : String(s.type);
    if (type !== 'Regular') return;
    const d = parseGameDate(s.date);
    // Strictly in the past — tonight's game is not late yet.
    if (!d || d >= today || d < earliest) return;
    candidates.push({ venue: s.venue, date: s.date, when: d });
  });

  if (!candidates.length) return [];

  const [checkinsSnap, elimsSnap] = await Promise.all([
    db.collection('checkins').get(),
    db.collection('eliminations').get(),
  ]);

  const gameKey = (venue, date, gameNum) => `${venue}||${dateKey(date)}||${gameNum || 1}`;

  const checkinCounts = new Map();
  checkinsSnap.forEach((docSnap) => {
    const c = docSnap.data();
    if (c.status === 'removed') return;
    const k = gameKey(c.venue, c.date, c.gameNum);
    checkinCounts.set(k, (checkinCounts.get(k) || 0) + 1);
  });

  const elimTotals = new Map();
  const elimProcessed = new Map();
  elimsSnap.forEach((docSnap) => {
    const e = docSnap.data();
    if (e.status === 'removed') return;
    const k = gameKey(e.venue, e.date, e.gameNum);
    elimTotals.set(k, (elimTotals.get(k) || 0) + 1);
    if (e.status === 'processed') elimProcessed.set(k, (elimProcessed.get(k) || 0) + 1);
  });

  const flagged = [];
  candidates.forEach(({ venue, date, when }) => {
    for (const gameNum of [1, 2]) {
      const k = gameKey(venue, date, gameNum);
      const checkins = checkinCounts.get(k) || 0;
      if (checkins === 0) continue; // that slot never ran — a one-game night is normal

      const elims = elimTotals.get(k) || 0;
      const processed = elimProcessed.get(k) || 0;

      let issue = null;
      if (elims === 0) issue = 'NEVER_SCORED';
      else if (processed === 0) issue = 'NOT_FINALIZED';
      if (!issue) continue;

      flagged.push({
        venue,
        date: dateKey(date),
        gameNum,
        issue,
        checkins,
        eliminations: elims,
        daysLate: Math.round((today.getTime() - when.getTime()) / (24 * 60 * 60 * 1000)),
      });
    }
  });

  flagged.sort((a, b) =>
    parseGameDate(a.date) - parseGameDate(b.date) || a.gameNum - b.gameNum);
  return flagged;
}

const unfinalizedKey = (g) => `${g.venue}|${g.date}|${g.gameNum}|${g.issue}`;

/**
 * Live scan, for any staff surface that wants to show the banner. Deliberately
 * NOT reading the cached sweep doc — staff opening the portal should see the
 * truth as of right now, including a game they finalized ten seconds ago.
 */
exports.getUnfinalizedGames = onCall(async (request) => {
  await requireRole(request, ['staff', 'admin']);
  const requested = parseInt((request.data || {}).lookbackDays, 10);
  const lookbackDays = Math.min(Math.max(requested || UNFINALIZED_LOOKBACK_DAYS, 1), 365);
  try {
    const games = await scanUnfinalizedGames(lookbackDays);
    return { status: 'success', games, lookbackDays };
  } catch (error) {
    console.error('getUnfinalizedGames error:', error);
    throw new HttpsError('internal', error.message);
  }
});

/**
 * Push to staff/admin only. The league-wide announcement push is the wrong
 * channel for this — players do not need to know a director is behind.
 *
 * Roles are stored two ways (role: 'staff' | isStaff: true), which Firestore
 * cannot OR across in one query, so this filters in memory. There are ~20
 * profiles total; when that stops being true, add a normalized role field.
 */
async function sendStaffPush({ title, body, link, tag }) {
  const snap = await db.collection('userProfiles').get();
  const tokenOwners = new Map();
  snap.forEach((docSnap) => {
    const p = docSnap.data() || {};
    if (!hasStaffRole(p)) return;
    if (p.preferences && p.preferences.push === false) return;
    (Array.isArray(p.pushTokens) ? p.pushTokens : []).forEach((t) => {
      if (!t) return;
      if (!tokenOwners.has(t)) tokenOwners.set(t, new Set());
      tokenOwners.get(t).add(docSnap.id);
    });
  });

  const tokens = [...tokenOwners.keys()];
  if (!tokens.length) return { sent: 0, failed: 0, recipients: 0 };

  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { url: link },
    android: { priority: 'high' },
    webpush: {
      fcmOptions: { link },
      notification: { title, body, tag, data: { url: link } },
    },
  });

  const sent = response.responses.filter(r => r.success).length;
  return { sent, failed: response.responses.length - sent, recipients: tokenOwners.size };
}

/**
 * Daily at 08:30 America/Denver — early enough to catch last night before the
 * 10:00 gameday announcement goes out, late enough that nobody is mid-finalize.
 *
 * Always refreshes config/unfinalizedGames. Pushes ONLY when a game appears
 * that was not flagged on the previous run: a lingering unfixed game keeps
 * showing in the banner but stops buzzing phones, so the notification keeps
 * meaning "something NEW is wrong".
 */
exports.unfinalizedGameSweep = onSchedule(
  { schedule: '30 8 * * *', timeZone: APP_TIMEZONE },
  async () => {
    try {
      const games = await scanUnfinalizedGames();
      const ref = db.collection('config').doc('unfinalizedGames');
      const prev = await ref.get();
      const prevKeys = new Set(((prev.exists && prev.data().games) || []).map(unfinalizedKey));
      const fresh = games.filter(g => !prevKeys.has(unfinalizedKey(g)));

      await ref.set({
        games,
        count: games.length,
        lookbackDays: UNFINALIZED_LOOKBACK_DAYS,
        scannedAt: FieldValue.serverTimestamp(),
      });

      if (!games.length) {
        console.log('unfinalizedGameSweep: all past Regular games are scored.');
        return;
      }

      console.log(
        `unfinalizedGameSweep: ${games.length} unfinalized game(s), ${fresh.length} new — ` +
        games.map(g => `${g.venue} ${g.date} G${g.gameNum} ${g.issue} (${g.checkins} check-ins, ${g.daysLate}d late)`).join('; ')
      );

      if (!fresh.length) return; // already reported — the banner covers it

      const lead = fresh[0];
      const verb = lead.issue === 'NEVER_SCORED' ? 'scored' : 'finalized';
      const body = fresh.length === 1
        ? `${lead.venue} ${lead.date} Game ${lead.gameNum} — ${lead.checkins} players checked in but the game was never ${verb}.`
        : `${fresh.length} games have check-ins but no finalized results. Oldest: ${lead.venue} ${lead.date} Game ${lead.gameNum}.`;

      try {
        const result = await sendStaffPush({
          title: 'Unfinalized game',
          body,
          link: `${getPublicAppBaseUrl()}/gameday.html`,
          tag: 'unfinalized-games',
        });
        console.log(`unfinalizedGameSweep: push -> ${JSON.stringify(result)}`);
      } catch (pushError) {
        console.error('unfinalizedGameSweep: push failed (non-blocking):', pushError);
      }
    } catch (error) {
      console.error('unfinalizedGameSweep: failed:', error);
    }
  }
);
