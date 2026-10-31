'use strict';
// Loads the demo club (demo/fixtures, one JSON file per Firestore collection)
// and holds the small date, venue and season helpers every tool shares.
// Read-only: nothing in this package writes to the fixtures.

const fs = require('fs');
const path = require('path');
const { ToolError } = require('./errors');

const DEFAULT_DIR = path.resolve(__dirname, '..', '..', 'demo', 'fixtures');
const COLLECTIONS = ['players', 'seasons', 'schedule', 'checkins', 'eliminations', 'bounties', 'rsvps', 'champ_overrides', 'timerClocks'];

function loadData(dir = process.env.POKER_DATA_DIR || DEFAULT_DIR) {
  const data = { dir };
  for (const c of COLLECTIONS) {
    const file = path.join(dir, `${c}.json`);
    if (!fs.existsSync(file)) throw new Error(`demo data missing: ${file} (run \`npm run seed\` at the repo root)`);
    const docs = JSON.parse(fs.readFileSync(file, 'utf8'));
    data[c] = Object.entries(docs).map(([id, d]) => ({ id, ...d }));
  }
  data.venues = [...new Set(data.seasons.map(s => s.venue))].sort();
  return data;
}

// ── dates ── the app stores M/D/YYYY strings; tools accept that or YYYY-MM-DD.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return utc(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return utc(+m[3], +m[1], +m[2]);
  return null;
}
function utc(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}
const mdy = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
const iso = (d) => d.toISOString().slice(0, 10);
/** Canonical M/D/YYYY for any accepted date string, or null. */
function dateKey(s) { const d = parseDate(s); return d ? mdy(d) : null; }
function inWindow(dateStr, start, end) {
  const d = parseDate(dateStr);
  if (!d) return false;
  const s = parseDate(start), e = parseDate(end);
  if (s && d < s) return false;
  if (e && d > e) return false;
  return true;
}
function requireDate(s) {
  const k = dateKey(s);
  if (!k) throw new ToolError('invalid_date', `"${s}" is not a date. Use M/D/YYYY (10/20/2026) or YYYY-MM-DD (2026-10-20).`);
  return k;
}

// ── venues ── case-insensitive; a unique partial match ("corgi") is accepted.
function resolveVenue(data, venue) {
  if (venue === undefined || venue === null || String(venue).trim() === '') {
    throw new ToolError('invalid_argument', 'venue is required.', { validVenues: data.venues });
  }
  const q = String(venue).trim().toLowerCase().replace(/\s+/g, ' ');
  const exact = data.venues.find(v => v.toLowerCase() === q);
  if (exact) return exact;
  const partial = data.venues.filter(v => v.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  throw new ToolError('unknown_venue', `No venue named "${venue}".`, { validVenues: data.venues });
}

// ── seasons ──
function asOfDate() {
  return parseDate(process.env.POKER_AS_OF || '') || new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
}
function seasonSummary(s) {
  return { seasonId: s.id, name: s.name, venue: s.venue, seasonNumber: s.seasonNumber, startDate: s.startDate, endDate: s.endDate || null, championshipDate: s.championshipDate || null };
}
/**
 * Pick a venue's season. `season` may be a name ("Fall 2026"), a season
 * number (2 or "2"), or a season id. Omitted: the season that most recently
 * started (the app's pickCurrentSeason rule).
 */
function resolveSeason(data, venue, season) {
  const list = data.seasons.filter(s => s.venue === venue);
  const available = list.map(s => `${s.name} (#${s.seasonNumber})`);
  if (season === undefined || season === null || String(season).trim() === '') {
    const today = asOfDate();
    let best = null;
    for (const s of list) {
      const st = parseDate(s.startDate);
      if (st && st <= today && (!best || st > parseDate(best.startDate))) best = s;
    }
    if (!best) best = list.slice().sort((a, b) => parseDate(a.startDate) - parseDate(b.startDate))[0];
    if (!best) throw new ToolError('unknown_season', `No seasons exist for ${venue}.`, { availableSeasons: [] });
    return withEnd(best, list);
  }
  const q = String(season).trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = list.find(s => s.id.toLowerCase() === q || s.name.toLowerCase() === q || String(s.seasonNumber) === q.replace(/^#|^season\s*/, ''));
  if (!hit) throw new ToolError('unknown_season', `No season "${season}" at ${venue}.`, { availableSeasons: available });
  return withEnd(hit, list);
}
// Effective end: an explicit endDate wins; blank means the day before the next season starts.
function withEnd(s, list) {
  if (parseDate(s.endDate)) return s;
  const start = parseDate(s.startDate);
  const next = list.filter(o => parseDate(o.startDate) > start).sort((a, b) => parseDate(a.startDate) - parseDate(b.startDate))[0];
  return { ...s, endDate: next ? mdy(new Date(parseDate(next.startDate).getTime() - 86400000)) : null };
}

/** Dates at a venue whose scheduled type is not season-eligible (Championship, Big Stack). */
function nonSeasonDates(data, venue) {
  const out = new Set();
  for (const r of data.schedule) {
    if ((r.venue || r.location) !== venue) continue;
    const t = r.type || 'Regular';
    if (t !== 'Regular') { const k = dateKey(r.date); if (k) out.add(k); }
  }
  return out;
}
const isRegular = (gameType) => (gameType === undefined || gameType === null || gameType === '' ? 'Regular' : String(gameType)) === 'Regular';

module.exports = { loadData, parseDate, dateKey, mdy, iso, inWindow, requireDate, resolveVenue, resolveSeason, seasonSummary, nonSeasonDates, isRegular, DEFAULT_DIR };
