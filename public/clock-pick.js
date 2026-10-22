// Which game the player app's clock bubble (clock-fab.js) points at.
// Pure, so scripts/clock-pick-test.js can run it in node.
import { clockAt, normalizeGame } from './clock-engine.js?v=2';

const VENUES = ['tight', 'corgi'];
const STALE_MS = 12 * 3600 * 1000;   // a game older than this is a previous night

// Main game by the clock on the wall (the owner, 2026-10-20): Game 1 before 9:00 PM
// Denver time, Game 2 from 9:00 PM. Every phone switches at the same moment,
// so the bubble follows the transfer to the late game for everyone.
const GAME2_FROM_MINS = 21 * 60;

export function denverMinutes(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value || 0);
  return get('hour') * 60 + get('minute');
}

// The main game for this time of night, before checking any clock.
export function mainKeyAt(now) {
  return denverMinutes(now) >= GAME2_FROM_MINS ? '2' : '1';
}

// One clock's main game (staff/clock-control.html opens on it): Game 2 from
// 9:00 PM Denver when Game 2's clock started tonight, otherwise Game 1.
// `levels` is the clock's structure (the page's default when none is stored).
export function mainGameFor(data, levels, now) {
  if (mainKeyAt(now) !== '2' || !levels || !levels.length) return '1';
  const g2 = normalizeGame(data && data.games && data.games['2'], levels);
  return g2 && g2.startedTonight && now - g2.changedAt <= STALE_MS ? '2' : '1';
}

// The game to point at: the main game for this time of night if its clock
// started tonight, otherwise the other one. Within that, a running clock
// beats a stopped one (it decides between the two venues).
export function pickFrom(docsByVenue, now) {
  const mainKey = mainKeyAt(now);
  let best = null;
  for (const venue of VENUES) {
    const data = docsByVenue[venue];
    const levels = data && data.structure && Array.isArray(data.structure.levels) ? data.structure.levels : null;
    if (!levels || !levels.length) continue;
    for (const key of ['1', '2']) {
      const game = normalizeGame(data.games && data.games[key], levels);
      if (!game || !game.startedTonight || now - game.changedAt > STALE_MS) continue;
      const view = clockAt(game, levels, now);
      const score = (key === mainKey ? 4 : 0) + (view.phase === 'running' ? 2 : 0) + (key === '1' ? 1 : 0);
      if (!best || score > best.score) best = { venue, game: key, view, score };
    }
  }
  return best;
}

