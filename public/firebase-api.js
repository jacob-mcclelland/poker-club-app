/**
 * Firebase API Helper
 *
 * Provides a clean API for HTML apps to call Firebase Cloud Functions.
 * Replaces all direct GAS API calls.
 *
 * Usage:
 *   import { PokerAPI } from './firebase-api.js';
 *   const result = await PokerAPI.checkin({ player: 'John', date: '1/15/2026', gameNum: 1, venue: 'Tight End' });
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, doc, getDocs, getDoc, setDoc, addDoc, deleteDoc, query, where, orderBy, onSnapshot, limit, serverTimestamp, increment } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// Firebase configuration
const firebaseConfig = {
  apiKey: "demo-api-key",
  authDomain: "demo-poker.firebaseapp.com",
  projectId: "demo-poker",
  storageBucket: "demo-poker.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000demo0000"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const functions = getFunctions(app);
const auth = getAuth(app);
const storage = getStorage(app);

// Uncomment to use emulator during development
// connectFunctionsEmulator(functions, "localhost", 5001);

// ===========================================
// CLOUD FUNCTION WRAPPERS
// ===========================================

/**
 * Shared player-name search/matching — THE single matcher for the whole app.
 *
 * Canonical version of the logic that originated in the check-in kiosk
 * (checkin.html). Every surface that searches players uses this so behavior
 * stays identical (a search like "bing" reliably finds the player "Bing").
 *
 * Entry points, by use case:
 *   matches(name, q)            -> boolean word-boundary filter (leaderboard list,
 *                                  "show every row whose name matches"). Strict:
 *                                  never matches mid-word, so "bing" excludes
 *                                  "Kirk DraBING".
 *   best(names, q)              -> single best match (standings card, stats lookup).
 *   rank(names, q, limit)       -> ranked word-boundary list (name-only autocompletes).
 *   search(directory, q, opts)  -> the rich dropdown pipeline: nickname expansion +
 *                                  substring-on-haystack(name+aliases) + Levenshtein
 *                                  fuzzy fallback + relevance ranking. Returns
 *                                  [{ name, aka }] where `aka` is the alias that
 *                                  caused the hit (for "(aka …)" display). Used by
 *                                  the check-in kiosk and RSVP autocompletes.
 *
 * score()/expandNicknames()/levenshtein() are shared internals, also exposed.
 */
// Short single-token names that are real canonical entries (not legacy partials)
// and must be exempt from the single-token demotion penalty in score().
const PROTECTED_SHORT_NAMES = new Set(['bing']);

const NICKNAME_MAP = {
  'alex': ['alexander', 'alexandra'], 'alexander': ['alex'], 'alexandra': ['alex'],
  'mike': ['michael'], 'michael': ['mike'],
  'rob': ['robert', 'bob'], 'robert': ['rob', 'bob'], 'bob': ['robert', 'rob'],
  'will': ['william', 'bill'], 'william': ['will', 'bill'], 'bill': ['william', 'will'],
  'jim': ['james'], 'james': ['jim'],
  'joe': ['joseph'], 'joseph': ['joe'],
  'tom': ['thomas'], 'thomas': ['tom'],
  'chris': ['christopher'], 'christopher': ['chris'],
  'matt': ['matthew'], 'matthew': ['matt'],
  'nick': ['nicholas'], 'nicholas': ['nick'],
  'sam': ['samuel', 'samantha'], 'samuel': ['sam'], 'samantha': ['sam'],
  'tony': ['anthony'], 'anthony': ['tony'],
  'steve': ['steven', 'stephen'], 'steven': ['steve'], 'stephen': ['steve'],
  'dave': ['david'], 'david': ['dave'],
  'dan': ['daniel'], 'daniel': ['dan'],
  'ben': ['benjamin'], 'benjamin': ['ben'],
  'jake': ['jacob'], 'jacob': ['jake'],
  'josh': ['joshua'], 'joshua': ['josh'],
  'pat': ['patrick'], 'patrick': ['pat'],
  'pete': ['peter'], 'peter': ['pete'],
  'rick': ['richard'], 'richard': ['rick'],
  'jeff': ['jeffrey'], 'jeffrey': ['jeff'],
  'jon': ['jonathan', 'john'], 'jonathan': ['jon'], 'john': ['jon'],
  'liz': ['elizabeth', 'lisa'], 'elizabeth': ['liz', 'beth'], 'beth': ['elizabeth'],
  'kate': ['katherine', 'kathy'], 'katherine': ['kate', 'kathy'], 'kathy': ['katherine', 'kate'],
  'sue': ['susan'], 'susan': ['sue'],
  'ed': ['edward', 'eddie'], 'edward': ['ed', 'eddie'],
  'greg': ['gregory'], 'gregory': ['greg'],
  'ken': ['kenneth'], 'kenneth': ['ken'],
  'len': ['leonard'], 'leonard': ['len'],
  'nate': ['nathaniel', 'nathan'], 'nathan': ['nate'], 'nathaniel': ['nate'],
  'andy': ['andrew'], 'andrew': ['andy'],
  'tim': ['timothy'], 'timothy': ['tim'],
  'ron': ['ronald'], 'ronald': ['ron'],
  'don': ['donald'], 'donald': ['don'],
  'ray': ['raymond'], 'raymond': ['ray'],
  'vince': ['vincent'], 'vincent': ['vince'],
};

function expandNicknames(term) {
  const t = String(term || '').toLowerCase();
  return [t, ...(NICKNAME_MAP[t] || [])];
}

export const PlayerSearch = {
  expandNicknames,
  PROTECTED_SHORT_NAMES,

  /** Whitespace-separated word count of a name. */
  wordCount(name) {
    return String(name || '').trim().split(/\s+/).filter(Boolean).length;
  },

  /** Standard Levenshtein edit distance. */
  levenshtein(a, b) {
    a = String(a || ''); b = String(b || '');
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
    );
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    return dp[m][n];
  },

  /**
   * Fuzzy match: any search term (>=3 chars) within 25% edit distance of any
   * word (>=3 chars) in the candidate string.
   */
  fuzzyMatchPlayer(candidateLower, searchWords) {
    const words = String(candidateLower || '').split(/\s+/);
    return searchWords.some(sw => {
      if (sw.length < 3) return false;
      return words.some(pw => {
        if (pw.length < 3) return false;
        const maxLen = Math.max(sw.length, pw.length);
        return this.levenshtein(sw, pw) / maxLen <= 0.25;
      });
    });
  },

  /**
   * Does `name` match `query`? Every query token must prefix-match a whole
   * word in the name (word boundary, not mid-word); nicknames count as
   * matching variants. Empty query matches everything. Strict — for filters.
   */
  matches(name, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const candidate = String(name || '').trim().toLowerCase();
    if (!candidate) return false;
    const nameWords = candidate.split(/\s+/).filter(Boolean);
    return q.split(/\s+/).filter(Boolean).every(token =>
      expandNicknames(token).some(variant =>
        nameWords.some(word => word.startsWith(variant))
      )
    );
  },

  /**
   * Relevance score for ranking matches (higher = better). Mirrors the kiosk's
   * scoreNameMatch exactly: rewards exact / full-prefix / word-prefix matches,
   * substring position, multi-word coverage; demotes vestigial single-token
   * legacy entries (except PROTECTED_SHORT_NAMES).
   */
  score(name, query) {
    const q = String(query || '').trim().toLowerCase();
    const candidate = String(name || '').trim();
    const lower = candidate.toLowerCase();
    const words = candidate.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const candidateLen = lower.length;
    let s = 0;
    if (!q) return s;
    if (lower === q) s += 2000;
    if (lower.startsWith(q)) s += 1200;
    if (words.some(w => w.toLowerCase().startsWith(q))) s += 900;
    const idx = lower.indexOf(q);
    if (idx >= 0) s += Math.max(500 - idx * 15, 150);
    if (q.includes(' ')) {
      const qWords = q.split(/\s+/).filter(Boolean);
      s += qWords.filter(qw => words.some(w => w.toLowerCase().startsWith(qw))).length * 250;
    }
    s += Math.min(wordCount, 4) * 120;
    if (wordCount >= 2) s += 200;
    if (!PROTECTED_SHORT_NAMES.has(lower)) {
      if (wordCount === 1 && candidateLen <= 5) s -= 450;
      else if (wordCount === 1 && candidateLen <= 8) s -= 180;
    }
    s += Math.min(candidateLen, 24);
    return s;
  },

  /**
   * Best single matching name from a list (or array of {name} objects).
   * Word-boundary gated, then highest score. Returns the name string or null.
   */
  best(names, query) {
    const q = String(query || '').trim();
    if (!q) return null;
    let bestName = null;
    let bestScore = -Infinity;
    for (const item of names) {
      const name = typeof item === 'string' ? item : (item && item.name);
      if (!name || !this.matches(name, q)) continue;
      const sc = this.score(name, q);
      if (sc > bestScore) { bestScore = sc; bestName = name; }
    }
    return bestName;
  },

  /**
   * Relevance-sort a list of names WITHOUT filtering — the caller has already
   * decided membership (e.g. a "did you mean" list). Mirrors the kiosk's old
   * rankMatchingNames.
   */
  sortByRelevance(names, query, limit = 8) {
    const q = String(query || '').trim();
    return names
      .map(n => ({ n, s: this.score(n, q), w: this.wordCount(n), l: String(n).trim().length }))
      .sort((a, b) => b.s - a.s || b.w - a.w || b.l - a.l || String(a.n).localeCompare(String(b.n)))
      .slice(0, limit)
      .map(e => e.n);
  },

  /** Filter (word-boundary) + relevance-sort a list of name strings. */
  rank(names, query, limit = 8) {
    const q = String(query || '').trim();
    if (!q) return [];
    return this.sortByRelevance(names.filter(n => this.matches(n, q)), q, limit);
  },

  /**
   * Rich dropdown search over a directory of { name, aliases } (plain name
   * strings are also accepted). Pipeline: nickname-expand the query ->
   * substring match across each entry's haystack (name + aliases) -> if fewer
   * than 3 hits and the query is >=4 chars, add a Levenshtein fuzzy pass ->
   * rank by relevance.
   *
   * Returns up to `limit` results as { name, aka }, where `aka` is the alias
   * that produced the match when the canonical name itself didn't match
   * (null otherwise) — for "(aka …)" hints. Set opts.fuzzy = false to disable
   * the fuzzy fallback.
   */
  search(directory, query, opts = {}) {
    const limit = opts.limit || 8;
    const fuzzy = opts.fuzzy !== false;
    const raw = String(query || '').toLowerCase().trim();
    if (!raw) return [];

    const expandedTerms = raw.split(/\s+/).filter(Boolean).flatMap(expandNicknames);
    const entries = (directory || []).map(e =>
      typeof e === 'string'
        ? { name: e, aliases: [] }
        : { name: e.name, aliases: Array.isArray(e.aliases) ? e.aliases : [] }
    );
    const haystack = (entry) => [entry.name, ...(entry.aliases || [])].map(s => String(s).toLowerCase());

    let matched = entries.filter(entry => {
      const hay = haystack(entry);
      return expandedTerms.some(t => hay.some(h => h.includes(t)));
    });

    if (fuzzy && matched.length < 3 && raw.length >= 4) {
      const already = new Set(matched.map(e => e.name));
      const fz = entries
        .filter(e => !already.has(e.name))
        .filter(e => haystack(e).some(h => this.fuzzyMatchPlayer(h, expandedTerms)));
      matched = [...matched, ...fz];
    }

    return matched
      .map(entry => ({ entry, s: this.score(entry.name, raw), w: this.wordCount(entry.name), l: String(entry.name).trim().length }))
      .sort((a, b) => b.s - a.s || b.w - a.w || b.l - a.l || String(a.entry.name).localeCompare(String(b.entry.name)))
      .slice(0, limit)
      .map(({ entry }) => {
        const nameLower = entry.name.toLowerCase();
        let aka = null;
        if (entry.aliases && entry.aliases.length) {
          aka = entry.aliases.find(a =>
            expandedTerms.some(t => a.toLowerCase().includes(t)) &&
            !expandedTerms.some(t => nameLower.includes(t))
          ) || null;
        }
        return { name: entry.name, aka };
      });
  },
};

/**
 * Main API object for all poker operations
 */
export const PokerAPI = {
  // ------------------------------------------
  // CHECK-IN OPERATIONS
  // ------------------------------------------

  /**
   * Check in a player for a game
   * @param {Object} params - { player, date, gameNum, venue }
   * @returns {Promise<{status, message, checkinId?, rsvpsConverted?}>}
   */
  async checkin({ player, date, gameNum, venue }) {
    const fn = httpsCallable(functions, 'checkin');
    const result = await fn({ player, date, gameNum, venue });
    return result.data;
  },

  /**
   * Remove a check-in
   * @param {Object} params - { checkinId } OR { player, date, gameNum, venue }
   * @returns {Promise<{status, message}>}
   */
  async removeCheckin(params) {
    const fn = httpsCallable(functions, 'removeCheckin');
    const result = await fn(params);
    return result.data;
  },

  // ------------------------------------------
  // RSVP OPERATIONS
  // ------------------------------------------

  /**
   * RSVP for a game
   * @param {Object} params - { player, date, gameNum (1, 2, or 'both'), venue, status? ('active'|'declined') }
   * @returns {Promise<{status, message, details}>}
   */
  async rsvp({ player, date, gameNum, venue, status }) {
    const fn = httpsCallable(functions, 'rsvp');
    const result = await fn({ player, date, gameNum, venue, status });
    return result.data;
  },

  /**
   * Remove an RSVP
   * @param {Object} params - { player, date, gameNum (1, 2, or 'both'), venue }
   * @returns {Promise<{status, message}>}
   */
  async removeRsvp({ player, date, gameNum, venue }) {
    const fn = httpsCallable(functions, 'removeRsvp');
    const result = await fn({ player, date, gameNum, venue });
    return result.data;
  },

  // ------------------------------------------
  // SCORING OPERATIONS
  // ------------------------------------------

  /**
   * Record bounty count for a player
   * @param {Object} params - { player, date, gameNum, venue, count }
   * @returns {Promise<{status, message, bountyId, isUpdate}>}
   */
  async recordBounty({ player, date, gameNum, venue, count }) {
    const fn = httpsCallable(functions, 'recordBounty');
    const result = await fn({ player, date, gameNum, venue, count });
    return result.data;
  },

  /**
   * Record player elimination
   * @param {Object} params - { player, date, gameNum, venue, rank }
   * @returns {Promise<{status, message, eliminationId}>}
   */
  async recordElimination({ player, date, gameNum, venue, rank }) {
    const fn = httpsCallable(functions, 'recordElimination');
    const result = await fn({ player, date, gameNum, venue, rank });
    return result.data;
  },

  /**
   * Undo a scoring entry (bounty or elimination)
   * @param {Object} params - { entryId, type ('bounty' or 'elimination') }
   * @returns {Promise<{status, message}>}
   */
  async undoScoring({ entryId, type }) {
    const fn = httpsCallable(functions, 'undoScoring');
    const result = await fn({ entryId, type });
    return result.data;
  },

  /**
   * Finalize a game - calculate points and mark as processed
   * @param {Object} params - { date, gameNum, venue }
   * @returns {Promise<{status, message, eliminations, bounties, tieAdjustments}>}
   */
  async finalizeGame({ date, gameNum, venue, submissionMeta }) {
    const fn = httpsCallable(functions, 'finalizeGame');
    const result = await fn({ date, gameNum, venue, submissionMeta });
    return result.data;
  },

  /**
   * Preview a game submission (read-only reconciliation report) BEFORE finalizing.
   * Returns a FULL/PARTIAL/BLOCK verdict, counts, per-player placements, and warnings.
   * @param {Object} params - { date, gameNum, venue }
   * @returns {Promise<{status, verdict, counts, placements, tieGroups, details, warnings}>}
   */
  async previewGameSubmission({ date, gameNum, venue }) {
    const fn = httpsCallable(functions, 'previewGameSubmission');
    const result = await fn({ date, gameNum, venue });
    return result.data;
  },

  // ------------------------------------------
  // READ OPERATIONS
  // ------------------------------------------

  /**
   * Get daily stats (check-ins and RSVPs)
   * @param {Object} params - { date, venue? }
   * @returns {Promise<{game1: {...}, game2: {...}}>}
   */
  async getDailyStats({ date, venue }) {
    const fn = httpsCallable(functions, 'getDailyStats');
    const result = await fn({ date, venue });
    return result.data;
  },

  /**
   * Get live scoring data for a game
   * @param {Object} params - { date, gameNum, venue }
   * @returns {Promise<{bounties: [], eliminations: []}>}
   */
  async getLiveScoring({ date, gameNum, venue }) {
    const fn = httpsCallable(functions, 'getLiveScoring');
    const result = await fn({ date, gameNum, venue });
    return result.data;
  },

  /**
   * Get master player list
   * `players` stays a plain string[] for backward compatibility with every
   * page that consumes it. `directory` is an additive parallel array that
   * also carries each player's search aliases.
   * @returns {Promise<{players: string[], directory: {name: string, aliases: string[]}[]}>}
   */
  async getPlayerList() {
    // Read directly from native Firestore to skip 5s Cloud Function latency
    const snap = await getDocs(query(collection(db, 'players'), orderBy('name')));
    const directory = snap.docs.map(doc => {
      const d = doc.data();
      return { name: d.name, aliases: Array.isArray(d.aliases) ? d.aliases : [] };
    });
    return { players: directory.map(p => p.name), directory };
  },

  /**
   * Set a player's search aliases (admin only)
   * @param {Object} params - { name: string, aliases: string[] }
   */
  async setPlayerAliases({ name, aliases }) {
    const fn = httpsCallable(functions, 'setPlayerAliases');
    const result = await fn({ name, aliases });
    return result.data;
  },

  /**
   * Get leaderboard standings
   * @param {Object} params - { venue, seasonId? }
   * @returns {Promise<{venue, championshipDate, standings: []}>}
   */
  async getLeaderboard({ venue, seasonId }) {
    const fn = httpsCallable(functions, 'getLeaderboard');
    const result = await fn({ venue, seasonId });
    return result.data;
  },

  async debugPlayerPoints({ playerName, venue }) {
    const fn = httpsCallable(functions, 'debugPlayerPoints');
    const result = await fn({ playerName, venue });
    return result.data;
  },

  async auditSeasonPoints({ venue, seasonId } = {}) {
    const fn = httpsCallable(functions, 'auditSeasonPoints');
    const result = await fn({ venue, seasonId });
    return result.data;
  },


  /**
   * Get previous completed season ID for a venue
   * @param {string} venue 
   * @returns {Promise<string|null>}
   */
  async getPreviousSeasonId(venue) {
    const snap = await getDocs(query(
      collection(db, 'seasons'),
      where('venue', '==', venue),
      where('active', '==', false)
    ));
    if (snap.empty) return null;
    
    // Sort locally to avoid needing a Firestore composite index
    const pastSeasons = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    pastSeasons.sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    
    return pastSeasons[0].id;
  },

  /**
   * Get historical winners from static config
   * @returns {Promise<{champions: {}, consolationWinners: {}}>}
   */
  async getHallOfFame() {
    try {
      const snap = await getDoc(doc(db, 'config', 'champions'));
      return snap.exists() ? snap.data() : {};
    } catch (err) {
      console.error('Firestore Error in getHallOfFame:', err);
      throw err;
    }
  },

  /**
   * Get season game-by-game breakdown for public stats page
   * @param {Object} params - { venue, seasonId? }
   * @returns {Promise<{status, venue, seasonName, games: [{date, gameNum, players: []}]}>}
   */
  async getSeasonBreakdown({ venue, seasonId } = {}) {
    const fn = httpsCallable(functions, 'getSeasonBreakdown');
    const result = await fn({ venue, seasonId });
    return result.data;
  },

  /**
   * Get schedule (upcoming or historical)
   * @param {Object} params - { historical?: boolean }
   * @returns {Promise<{schedule: []}>}
   */
  async getSchedule({ historical, all } = {}) {
    const result = await httpsCallable(functions, 'getSchedule')({ historical, all });
    return result.data;
  },

  /**
   * Find potential duplicate players using fuzzy matching
   * @param {Object} params - { threshold?: number (0-100, default 80) }
   * @returns {Promise<{duplicateGroups: Array, totalPlayers: number}>}
   */
  async findDuplicatePlayers({ threshold = 80 } = {}) {
    const fn = httpsCallable(functions, 'findDuplicatePlayers');
    const result = await fn({ threshold });
    return result.data;
  },

  /**
   * Merge duplicate players into a canonical name
   * @param {Object} params - { canonicalName: string, duplicateIds: string[] }
   * @returns {Promise<{status, message, updatedRecords}>}
   */
  async mergePlayers({ canonicalName, duplicateIds }) {
    const fn = httpsCallable(functions, 'mergePlayers');
    const result = await fn({ canonicalName, duplicateIds });
    return result.data;
  },

  /**
   * Delete a player from the master list
   * @param {Object} params - { playerId: string, force?: boolean }
   * @returns {Promise<{status, message}>}
   */
  async deletePlayer({ playerId, force = false }) {
    const fn = httpsCallable(functions, 'deletePlayer');
    const result = await fn({ playerId, force });
    return result.data;
  },

  /**
   * Save a championship director manual override
   * @param {Object} params - { venue, date, gameNum, player, section }
   */
  async saveChampOverride({ venue, date, gameNum, player, section }) {
    const fn = httpsCallable(functions, 'saveChampOverride');
    const result = await fn({ venue, date, gameNum, player, section });
    return result.data;
  },

  /**
   * Get championship director manual overrides for a venue+date
   * @param {Object} params - { venue, date }
   * @returns {Promise<{ overrides: { 1: {}, 2: {} } }>}
   */
  async getChampOverrides({ venue, date }) {
    const fn = httpsCallable(functions, 'getChampOverrides');
    const result = await fn({ venue, date });
    return result.data;
  },

  // ------------------------------------------
  // HAND OF THE NIGHT OPERATIONS
  // ------------------------------------------

  /**
   * Get the current Hand of the Night for a venue
   * @param {Object} params - { venue }
   * @returns {Promise<{ hand, bonus, theme }>}
   */
  async getHandOfNight({ venue }) {
    const fn = httpsCallable(functions, 'getHandOfNight');
    const result = await fn({ venue });
    return result.data;
  },

  /**
   * Save the Hand of the Night for a venue
   * @param {Object} params - { venue, hand, bonus, theme }
   * @returns {Promise<{ success }>}
   */
  async saveHandOfNight({ venue, hand, bonus, theme }) {
    const fn = httpsCallable(functions, 'saveHandOfNight');
    const result = await fn({ venue, hand, bonus, theme });
    return result.data;
  },

  /**
   * Clear the Hand of the Night for a venue
   * @param {Object} params - { venue }
   * @returns {Promise<{ success }>}
   */
  async clearHandOfNight({ venue }) {
    const fn = httpsCallable(functions, 'clearHandOfNight');
    const result = await fn({ venue });
    return result.data;
  },

  // ------------------------------------------
  // HIGH HAND OPERATIONS
  // ------------------------------------------

  /**
   * Get current high hands for all venues
   * @returns {Promise<Object>} - { 'Tight End': {player, hand, pot}, 'Wild Corgi': {...} }
   */
  async getHighHands() {
    try {
      const snap = await getDoc(doc(db, 'config', 'highHands'));
      return snap.exists() ? snap.data() : {};
    } catch (err) {
      console.error('Firestore Error in getHighHands:', err);
      return {};
    }
  },

  /**
   * Update high hand for a venue
   * @param {Object} params - { venue, player, hand, pot }
   */
  async saveHighHand({ venue, player, hand, pot }) {
    const fn = httpsCallable(functions, 'saveHighHand');
    const result = await fn({ venue, player, hand, pot });
    return result.data;
  },

  /**
   * Past game nights that have check-ins but no finalized results.
   * Staff/admin only — throws permission-denied for everyone else.
   * Live scan, so a game finalized ten seconds ago is already gone from it.
   * @param {number} [lookbackDays]
   * @returns {Promise<{status: string, games: Array, lookbackDays: number}>}
   */
  /**
   * Give a player attendance credit (10 pts) for a game, even one already
   * finalized. Staff or admin. Server writes a single attendanceOnly checkin,
   * restores a removed one, or reports 'exists' / 'not_needed'.
   * @param {Object} params - { player, date, gameNum, venue }
   * @returns {Promise<{status: 'success'|'restored'|'exists'|'not_needed', message}>}
   */
  async addAttendanceCredit({ player, date, gameNum, venue }) {
    const fn = httpsCallable(functions, 'addAttendanceCredit');
    const result = await fn({ player, date, gameNum, venue });
    return result.data;
  },

  async getUnfinalizedGames(lookbackDays) {
    const fn = httpsCallable(functions, 'getUnfinalizedGames');
    const result = await fn(lookbackDays ? { lookbackDays } : {});
    return result.data;
  },

  // ------------------------------------------
  // ANNOUNCEMENTS
  // ------------------------------------------

  /**
   * Get recent announcements
   * @param {number} limitCount
   * @returns {Promise<Array>}
   */
  async getAnnouncements(limitCount = 20) {
    const q = query(collection(db, 'announcements'), orderBy('createdAt', 'desc'), limit(limitCount));
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(post => post.status !== 'deleted' && !post.deletedAt);
  },

  /**
   * Create a new announcement
   * @param {Object} params - { title, content, type, imageUrl?, sourceUrl? }
   */
  async createAnnouncement({ title, content, type = 'info', imageUrl = null, sourceUrl = null }) {
    const fn = httpsCallable(functions, 'createAnnouncement');
    const result = await fn({ title, content, type, imageUrl, sourceUrl });
    return result.data;
  },

  async updateAnnouncement({ announcementId, title, content, type = 'info', imageUrl = null, sourceUrl = null, removeImage = false }) {
    const fn = httpsCallable(functions, 'updateAnnouncement');
    const result = await fn({ announcementId, title, content, type, imageUrl, sourceUrl, removeImage });
    return result.data;
  },

  async deleteAnnouncement({ announcementId }) {
    const fn = httpsCallable(functions, 'deleteAnnouncement');
    const result = await fn({ announcementId });
    return result.data;
  },

  // ------------------------------------------
  // PUSH NOTIFICATIONS — DISABLED (2026-04-22)
  // ------------------------------------------
  // Push messaging was pulled after it caused a full app outage.
  //
  // ROOT CAUSE: firebase-messaging.js was added as a static ES module import
  // at the top of this file. Static imports block the entire module tree from
  // loading if the import fails or if firebase.messaging() throws during SW
  // evaluation. Because EVERY page imports firebase-api.js, one broken import
  // silenced every page (HTML loaded, but no JS ran, no buttons worked).
  //
  // The service worker (sw.js) also called firebase.messaging() at the top
  // level — outside any event handler — which caused the SW to fail to install
  // in certain browsers. The 4-hour delay before the outage was the service
  // worker update cycle: users on the old SW finally cycled to the new one
  // around game time (~6:30 PM) and got the broken version.
  //
  // TO REINSTATE SAFELY:
  //   1. Use a DYNAMIC import (import()) for firebase-messaging.js inside the
  //      methods below — never a static top-level import.
  //   2. In sw.js, wrap firebase.messaging() inside the 'install' event handler
  //      with a try/catch, NOT at the top level of the script.
  //   3. Test in a private/incognito window with DevTools → Application →
  //      Service Workers to confirm SW installs cleanly before deploying.
  //   4. Deploy sw.js change separately first, verify SW installs, THEN
  //      add the messaging import to firebase-api.js.
  //   5. Bump CACHE_NAME in sw.js any time sw.js changes.
  // ------------------------------------------

  async getClientConfig() {
    return {};
  },

  async enablePushNotifications() {
    return { status: 'disabled' };
  },

  async disablePushNotifications() {
    localStorage.removeItem('fcmToken');
    return { status: 'disabled' };
  },

  async syncPushRegistration() {
    return { status: 'disabled' };
  },

  /**
   * Log a client-side operational error for later audit
   * @param {Object} params - { source, page, action, message, code?, severity?, context? }
   */
  async logClientError({ source, page, action, message, code, severity = 'error', context = {} }) {
    const fn = httpsCallable(functions, 'logClientError');
    const result = await fn({ source, page, action, message, code, severity, context });
    return result.data;
  },

  /**
   * Upload an announcement image to Firebase Storage
   * @param {File} file
   * @returns {Promise<string>} download URL
   */
  async uploadAnnouncementImage(file) {
    const ext = file.name.split('.').pop();
    const path = `announcements/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const imgRef = storageRef(storage, path);
    await uploadBytes(imgRef, file);
    return getDownloadURL(imgRef);
  },

  // ------------------------------------------
  // EMAIL / PLAYER PROFILE
  // ------------------------------------------

  /**
   * Sign up for email announcements (landing page)
   * @param {Object} params - { name, email }
   */
  async emailSignup({ name, email }) {
    const fn = httpsCallable(functions, 'emailSignup');
    const result = await fn({ name, email });
    return result.data;
  },

  /**
   * Save email for a player (check-in kiosk)
   * @param {Object} params - { player, email }
   */
  async updatePlayerEmail({ player, email, onlyIfMissing = false, source = 'profile' }) {
      const fn = httpsCallable(functions, 'updatePlayerEmail');
      const result = await fn({ player, email, onlyIfMissing, source });
      return result.data;
    },
  };

// ===========================================
// REAL-TIME LISTENERS (Direct Firestore)
// ===========================================

/**
 * Real-time listener utilities
 * Use these for live updates without polling
 */
export const PokerRealtime = {
  /**
   * Subscribe to check-ins for a date/venue
   * @param {Object} params - { date, venue, gameNum? }
   * @param {Function} callback - Called with array of check-ins
   * @returns {Function} Unsubscribe function
   */
  subscribeToCheckins({ date, venue, gameNum }, callback) {
    let q = query(
      collection(db, 'checkins'),
      where('date', '==', date),
      where('venue', '==', venue),
      where('status', '==', 'active')
    );

    if (gameNum) {
      q = query(
        collection(db, 'checkins'),
        where('date', '==', date),
        where('venue', '==', venue),
        where('gameNum', '==', parseInt(gameNum)),
        where('status', '==', 'active')
      );
    }

    return onSnapshot(q, (snapshot) => {
      const checkins = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      callback(checkins);
    });
  },

  /**
   * Subscribe to RSVPs for a date/venue
   * @param {Object} params - { date, venue, gameNum? }
   * @param {Function} callback - Called with array of RSVPs
   * @returns {Function} Unsubscribe function
   */
  subscribeToRsvps({ date, venue, gameNum }, callback) {
    let q = query(
      collection(db, 'rsvps'),
      where('date', '==', date),
      where('venue', '==', venue),
      where('status', '==', 'active')
    );

    if (gameNum) {
      q = query(
        collection(db, 'rsvps'),
        where('date', '==', date),
        where('venue', '==', venue),
        where('gameNum', '==', parseInt(gameNum)),
        where('status', '==', 'active')
      );
    }

    return onSnapshot(q, (snapshot) => {
      const rsvps = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      callback(rsvps);
    });
  },

  /**
   * Subscribe to live scoring for a game
   * @param {Object} params - { date, gameNum, venue }
   * @param {Function} callback - Called with { bounties: [], eliminations: [] }
   * @returns {Function} Unsubscribe function
   */
  subscribeToLiveScoring({ date, gameNum, venue }, callback) {
    const unsubBounties = onSnapshot(
      query(
        collection(db, 'bounties'),
        where('date', '==', date),
        where('gameNum', '==', parseInt(gameNum)),
        where('venue', '==', venue),
        where('status', '==', 'active')
      ),
      () => fetchAndCallback()
    );

    const unsubElims = onSnapshot(
      query(
        collection(db, 'eliminations'),
        where('date', '==', date),
        where('gameNum', '==', parseInt(gameNum)),
        where('venue', '==', venue),
        where('status', '==', 'active')
      ),
      () => fetchAndCallback()
    );

    let lastData = { bounties: [], eliminations: [] };

    async function fetchAndCallback() {
      const [bountiesSnap, elimsSnap] = await Promise.all([
        getDocs(query(
          collection(db, 'bounties'),
          where('date', '==', date),
          where('gameNum', '==', parseInt(gameNum)),
          where('venue', '==', venue),
          where('status', '==', 'active')
        )),
        getDocs(query(
          collection(db, 'eliminations'),
          where('date', '==', date),
          where('gameNum', '==', parseInt(gameNum)),
          where('venue', '==', venue),
          where('status', '==', 'active')
        ))
      ]);

      lastData = {
        bounties: bountiesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        eliminations: elimsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      };

      callback(lastData);
    }

    // Initial fetch
    fetchAndCallback();

    // Return combined unsubscribe
    return () => {
      unsubBounties();
      unsubElims();
    };
  },

};

// ===========================================
// SESSION CONTEXT (tonight's venue + which game by time)
// ===========================================

/**
 * Shared "what game are we in right now" logic — the single source of truth for
 * surfaces that need to auto-assign to tonight's venue and the 7pm vs 9pm game
 * (currently the shot-round ordering page and the bartender view).
 *
 * Venue/date come from the schedule (one venue per date on a normal night).
 * Game number comes from the wall clock, using a single clean cutoff so there
 * is never a "no game" gap: before the cutoff is Game 1 (7pm), at/after is
 * Game 2 (9pm). The cutoff matches the league's real-world rhythm — the 9pm
 * game gets seated around 8:50pm.
 */
const GAME2_CUTOFF_MINS = 20 * 60 + 50;        // 8:50 PM — 9pm game begins
const SHOTS_CLOSED_START_MINS = 19 * 60 + 50;  // 7:50 PM — 7pm game has wrapped
const SHOTS_FAB_START_MINS = 18 * 60 + 30;     // 6:30 PM — "Shots" shortcut appears (before the 7 PM game)
const SHOTS_FAB_END_MINS = 21 * 60 + 50;       // 9:50 PM — "Shots" shortcut hides

export const PokerSession = {
  GAME2_CUTOFF_MINS,
  SHOTS_CLOSED_START_MINS,
  SHOTS_FAB_START_MINS,
  SHOTS_FAB_END_MINS,

  /** Today as the app's canonical locale date string (e.g. "1/15/2026"). */
  todayStr() {
    return new Date().toLocaleDateString();
  },

  /** Minutes since midnight, local time. */
  nowMinutes() {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  },

  /**
   * Date-string equality for M/D/YYYY strings. Compares the numeric
   * month/day/year triple so "1/5/2026" and "01/05/2026" match, while
   * "12/1/2026" does NOT match "2/1/2026" (a substring compare would — that
   * false positive once let a previous night's orders leak into the bar view).
   */
  datesMatch(d1, d2) {
    const parse = s => {
      const parts = String(s || '').trim().split('/');
      if (parts.length !== 3) return null;
      const nums = parts.map(Number);
      return nums.every(Number.isFinite) ? nums : null;
    };
    const a = parse(d1), b = parse(d2);
    if (!a || !b) return false;
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  },

  /**
   * Which game (1 or 2) the given minute-of-day belongs to. Single cutoff,
   * no gap. Defaults to "now".
   */
  currentGameNum(mins = this.nowMinutes()) {
    return mins >= GAME2_CUTOFF_MINS ? 2 : 1;
  },

  /**
   * "Way past" the earlier game — used by the bartender view to auto-hide
   * Game 1 clutter well after the Game 2 cutoff (grace buffer of ~40 min).
   */
  isWellPastGame1(mins = this.nowMinutes()) {
    return mins >= GAME2_CUTOFF_MINS + 40; // ~9:30 PM
  },

  /**
   * Whether shot rounds are accepted right now. Ordering stays open all day on
   * any game night — the league decided (2026-07-15) that keeping the option
   * available is more important than pausing it during the between-games gap,
   * so there is no longer a 7:50–8:50 PM close. Args are kept for callers.
   */
  isShotsOpen(mins = this.nowMinutes(), eventType = 'Regular') {
    return true;
  },

  /**
   * Whether the discreet "Shots" shortcut (the player-app FAB that normally
   * shows notifications) should be shown. Broad evening window (6:30–9:50 PM)
   * so players can reach ordering before the 7pm game and through the 9pm game;
   * the shots page itself enforces the 7:50–8:50 pause. Callers should also gate
   * on there actually being a game scheduled tonight.
   */
  isShotsFabWindow(mins = this.nowMinutes()) {
    return mins >= SHOTS_FAB_START_MINS && mins < SHOTS_FAB_END_MINS;
  },

  /** Human label for a game number, event-type aware (matches the kiosk). */
  gameLabel(n, eventType = '') {
    const t = String(eventType || '').toLowerCase();
    if (t.includes('championship')) return n === 1 ? 'Bounty' : 'Championship';
    if (t.includes('big stack')) return n === 1 ? 'Big Stack' : 'Consolation';
    return n === 1 ? 'Game 1 · 7PM' : 'Game 2 · 9PM';
  },

  /**
   * Resolve tonight's scheduled entries (date, venue, eventType). Returns the
   * raw list so callers can decide how to handle 0, 1, or 2 venues on a date.
   *   { today, entries: [{ date, venue, eventType }] }
   */
  async getTonight() {
    let schedule = [];
    try {
      const res = await PokerAPI.getSchedule();
      schedule = res.schedule || [];
    } catch (e) {
      console.warn('PokerSession.getTonight: schedule load failed', e);
    }
    const today = this.todayStr();
    const entries = schedule
      .filter(g => this.datesMatch(g.date, today))
      .map(g => ({
        date: g.date,
        venue: g.location || g.venue || '',
        eventType: g.type || 'Regular'
      }));
    return { today, entries };
  }
};

// ===========================================
// OPTIMISTIC UI HELPERS
// ===========================================

/**
 * Helper for optimistic UI pattern
 * Use these when you want instant feedback but reliable rollback
 */
export const OptimisticUI = {
  /**
   * Perform an action with optimistic UI
   * @param {Object} options
   * @param {Function} options.optimisticUpdate - Called immediately to update local state
   * @param {Function} options.apiCall - Async function that calls the API
   * @param {Function} options.onSuccess - Called on successful API response
   * @param {Function} options.onError - Called on API error (should rollback)
   */
  async execute({ optimisticUpdate, apiCall, onSuccess, onError }) {
    // Immediately apply optimistic update
    const rollbackData = optimisticUpdate();

    try {
      const result = await apiCall();

      if (result.status === 'success') {
        onSuccess(result);
      } else {
        // API returned non-success (duplicate, error, etc.)
        onError(result, rollbackData);
      }

      return result;
    } catch (error) {
      // Network or other error
      onError({ status: 'error', message: error.message }, rollbackData);
      throw error;
    }
  }
};


// ===========================================
// EXPORTS
// ===========================================

// Export Firebase instances for direct access if needed
export { db, storage, functions, app, auth, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged, GoogleAuthProvider, setDoc, doc, getDoc, addDoc, deleteDoc, getDocs, collection, query, where, orderBy, onSnapshot, limit, serverTimestamp, increment, httpsCallable };

// Default export
export default PokerAPI;
