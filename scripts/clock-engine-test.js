// Exercises the synced clock engine in public/clock-engine.js.
// No DOM, no network. Run: node scripts/clock-engine-test.js
const fs = require('fs');
const path = require('path');

// The module is browser ESM; strip the `export` keywords and evaluate it.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'clock-engine.js'), 'utf8')
  .replace(/^export const /mg, 'const ')
  .replace(/^export function /mg, 'function ');
const { clockAt, applyAction, initialGame, normalizeGame, isNewer, levelDurationMs, rebaseGame } =
  new Function(src + '\n return { clockAt, applyAction, initialGame, normalizeGame, isNewer, levelDurationMs, rebaseGame };')();

// Same shape as BLIND_LEVELS in public/staff/timer.html (trimmed).
const LEVELS = [
  { level: 0, name: 'Draw for Seats', duration: 5, isPreGame: true },
  { level: 0, name: 'Announcements', duration: 5, isPreGame: true },
  { level: 1, name: 'Round 1', duration: 12 },
  { level: 2, name: 'Round 2', duration: 12 },
  { level: 'B1', name: 'Break', duration: 8, isBreak: true },
  { level: 3, name: 'Round 3', duration: 12 },
  { level: 4, name: 'Round 4', duration: 12 }
];
const MIN = 60000;
const T0 = 1760000000000;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`    PASS ${name}`);
  } else {
    failures++;
    console.log(`    FAIL ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}
function running(levelIndex, remainingMs, anchorAt = T0) {
  return { levelIndex, status: 'running', remainingMs, anchorAt, changedAt: anchorAt, startedTonight: true };
}
function paused(levelIndex, remainingMs, anchorAt = T0) {
  return { levelIndex, status: 'paused', remainingMs, anchorAt, changedAt: anchorAt, startedTonight: true };
}

console.log('clockAt');
{
  const c = clockAt(paused(2, 7 * MIN), LEVELS, T0 + 99 * MIN);
  check('paused clock does not move', c.phase === 'paused' && c.levelIndex === 2 && c.remainingMs === 7 * MIN, c);
}
{
  const c = clockAt(running(2, 12 * MIN), LEVELS, T0 + 5 * MIN);
  check('running mid-level counts down', c.phase === 'running' && c.levelIndex === 2 && c.remainingMs === 7 * MIN, c);
}
{
  // Round 1 has 1 min left; 1 min later Round 2 starts at full time.
  const c = clockAt(running(2, 1 * MIN), LEVELS, T0 + 1 * MIN);
  check('exact boundary rolls into the next level', c.levelIndex === 3 && c.remainingMs === 12 * MIN && c.phase === 'running', c);
}
{
  // Start of Draw for Seats, 16 min later: 5 + 5 pre-game, 6 into Round 1.
  const c = clockAt(running(0, 5 * MIN), LEVELS, T0 + 16 * MIN);
  check('pre-game rolls into Round 1 without a press', c.levelIndex === 2 && c.remainingMs === 6 * MIN && c.phase === 'running', c);
}
{
  // Round 2 with 2 min left, then 3 min later: in the break with 7 min left.
  const c = clockAt(running(3, 2 * MIN), LEVELS, T0 + 3 * MIN);
  check('round rolls into a break and keeps running', c.levelIndex === 4 && c.remainingMs === 7 * MIN && c.phase === 'running', c);
}
{
  // Break with 1 min left; 10 min later the clock is holding at Round 3, full time.
  const c = clockAt(running(4, 1 * MIN), LEVELS, T0 + 10 * MIN);
  check('break end holds at the next level, full time', c.phase === 'holding' && c.levelIndex === 5 && c.remainingMs === 12 * MIN, c);
}
{
  // Several silent levels: Round 1 start, 40 min later: R1 12 + R2 12 + break 8 = 32, holding.
  const c = clockAt(running(2, 12 * MIN), LEVELS, T0 + 40 * MIN);
  check('multi-level rollover stops at the first break end', c.phase === 'holding' && c.levelIndex === 5, c);
}
{
  const c = clockAt(running(6, 1 * MIN), LEVELS, T0 + 5 * MIN);
  check('last level ends finished at 0:00', c.phase === 'finished' && c.levelIndex === 6 && c.remainingMs === 0, c);
}
{
  const c = clockAt(running(2, 12 * MIN, T0 + 2000), LEVELS, T0);
  check('anchor slightly in the future does not add time', c.remainingMs === 12 * MIN, c);
}
{
  const c = clockAt(paused(5, 12 * MIN), LEVELS, T0);
  check('paused at full time right after a break reads as holding', c.phase === 'holding', c);
  const d = clockAt(paused(5, 11 * MIN), LEVELS, T0);
  check('paused mid-level after a break reads as paused', d.phase === 'paused', d);
}

console.log('applyAction');
{
  const g = initialGame(LEVELS, T0);
  check('initial game: Draw for Seats, paused, 5:00, not started',
    g.levelIndex === 0 && g.status === 'paused' && g.remainingMs === 5 * MIN && g.startedTonight === false, g);
  const s = applyAction(g, LEVELS, 'start', T0 + 1000);
  check('start runs and marks the game started', s.status === 'running' && s.startedTonight === true && s.anchorAt === T0 + 1000, s);
}
{
  const g = running(2, 12 * MIN);
  const p = applyAction(g, LEVELS, 'pause', T0 + 4 * MIN);
  check('pause freezes the remaining time', p.status === 'paused' && p.remainingMs === 8 * MIN && p.changedAt === T0 + 4 * MIN, p);
  const r = applyAction(p, LEVELS, 'start', T0 + 9 * MIN);
  const c = clockAt(r, LEVELS, T0 + 10 * MIN);
  check('resume continues from the paused time', c.remainingMs === 7 * MIN && c.levelIndex === 2, c);
}
{
  const g = running(2, 12 * MIN);
  const t1 = applyAction(g, LEVELS, 'toggle', T0 + MIN);
  const t2 = applyAction(t1, LEVELS, 'toggle', T0 + 2 * MIN);
  check('toggle pauses then starts', t1.status === 'paused' && t2.status === 'running' && t2.remainingMs === 11 * MIN, [t1, t2]);
}
{
  const a = applyAction(running(2, 12 * MIN), LEVELS, 'addMinute', T0 + 2 * MIN);
  check('add minute while running keeps running with +1:00', a.status === 'running' && a.remainingMs === 11 * MIN, a);
  const s = applyAction(paused(2, 30000), LEVELS, 'subtractMinute', T0);
  check('subtract minute floors at 0:00', s.remainingMs === 0, s);
}
{
  const n = applyAction(running(2, 5 * MIN), LEVELS, 'next', T0);
  check('next: following level, full time, paused', n.levelIndex === 3 && n.remainingMs === 12 * MIN && n.status === 'paused', n);
  const p = applyAction(running(3, 5 * MIN), LEVELS, 'prev', T0);
  check('prev: previous level, full time, paused', p.levelIndex === 2 && p.remainingMs === 12 * MIN && p.status === 'paused', p);
  const first = applyAction(paused(0, MIN), LEVELS, 'prev', T0);
  const last = applyAction(paused(6, MIN), LEVELS, 'next', T0);
  check('prev at the first level and next at the last are no-ops on the level', first.levelIndex === 0 && last.levelIndex === 6, [first, last]);
}
{
  const r = applyAction(running(5, 3 * MIN), LEVELS, 'reset', T0 + MIN);
  check('reset returns to Draw for Seats, paused, not started',
    r.levelIndex === 0 && r.status === 'paused' && r.remainingMs === 5 * MIN && r.startedTonight === false && r.changedAt === T0 + MIN, r);
}
{
  // Break ran out 30 s ago and the clock is holding; the director presses start.
  const g = running(4, 1 * MIN);
  const s = applyAction(g, LEVELS, 'start', T0 + 90000);
  const c = clockAt(s, LEVELS, T0 + 90000 + 1000);
  check('start from holding runs the next level from full time',
    s.levelIndex === 5 && s.remainingMs === 12 * MIN && c.phase === 'running' && c.remainingMs === 12 * MIN - 1000, [s, c]);
}
{
  // A press after silent rollovers lands on the real level, not the anchor's.
  const g = running(2, 12 * MIN);
  const p = applyAction(g, LEVELS, 'pause', T0 + 15 * MIN);
  check('pause after a silent rollover pauses the current level', p.levelIndex === 3 && p.remainingMs === 9 * MIN, p);
}
{
  let threw = false;
  try { applyAction(running(2, MIN), LEVELS, 'explode', T0); } catch (e) { threw = true; }
  check('unknown action throws', threw);
}

console.log('prev onto the level after a break');
{
  // Round 3 (index 5) follows the Break (index 4). Prev from Round 4 lands on Round 3.
  const p = applyAction(running(6, 5 * MIN), LEVELS, 'prev', T0);
  check('prev onto the level after a break reads as paused, not holding', clockAt(p, LEVELS, T0 + MIN).phase === 'paused' && p.noHold === true, p);
  const s = applyAction(p, LEVELS, 'start', T0 + 2 * MIN);
  check('the next press drops the flag', s.noHold === undefined && s.status === 'running', s);
  const n = applyAction(running(4, 3 * MIN), LEVELS, 'next', T0);
  check('next out of a break still reads as holding', clockAt(n, LEVELS, T0 + MIN).phase === 'holding' && !n.noHold, n);
  const kept = normalizeGame({ ...p }, LEVELS);
  check('the flag survives a save and reload', kept.noHold === true && clockAt(kept, LEVELS, T0).phase === 'paused', kept);
  const plain = normalizeGame({ ...paused(5, 12 * MIN), noHold: 'yes' }, LEVELS);
  check('only a true flag counts', plain.noHold === undefined && clockAt(plain, LEVELS, T0).phase === 'holding', plain);
  const rb = rebaseGame(p, LEVELS, T0 + 3 * MIN);
  check('rebase keeps the flag on a paused clock', rb.noHold === true && clockAt(rb, LEVELS, T0 + 4 * MIN).phase === 'paused', rb);
}

console.log('rebaseGame');
{
  const g = running(2, 12 * MIN);
  const r = rebaseGame(g, LEVELS, T0 + 15 * MIN);
  const before = clockAt(g, LEVELS, T0 + 16 * MIN);
  const after = clockAt(r, LEVELS, T0 + 16 * MIN);
  check('rebase keeps the same clock', before.levelIndex === after.levelIndex && before.remainingMs === after.remainingMs && after.phase === 'running', [before, after]);
  check('rebase stamps the new anchor as the newest change', r.anchorAt === T0 + 15 * MIN && r.changedAt === T0 + 15 * MIN && isNewer(r, g), r);
  const h = rebaseGame(running(4, MIN), LEVELS, T0 + 5 * MIN);
  check('rebase of a holding clock stays holding', h.status === 'paused' && clockAt(h, LEVELS, T0 + 6 * MIN).phase === 'holding', h);
}

console.log('normalizeGame / isNewer');
{
  const ok = normalizeGame({ levelIndex: 3, status: 'running', remainingMs: 5000, anchorAt: T0, changedAt: T0, startedTonight: true }, LEVELS);
  check('valid record passes through', ok && ok.levelIndex === 3 && ok.startedTonight === true, ok);
  check('level out of range is rejected', normalizeGame({ levelIndex: 99, status: 'paused', remainingMs: 0, anchorAt: T0, changedAt: T0 }, LEVELS) === null);
  check('unknown status is rejected', normalizeGame({ levelIndex: 1, status: 'idle', remainingMs: 0, anchorAt: T0, changedAt: T0 }, LEVELS) === null);
  check('negative time is rejected', normalizeGame({ levelIndex: 1, status: 'paused', remainingMs: -5, anchorAt: T0, changedAt: T0 }, LEVELS) === null);
  check('missing anchor is rejected', normalizeGame({ levelIndex: 1, status: 'paused', remainingMs: 5 }, LEVELS) === null);
  check('null is rejected', normalizeGame(null, LEVELS) === null);
  check('newer press wins', isNewer(paused(1, 1, T0 + 5), paused(1, 1, T0)) && !isNewer(paused(1, 1, T0), paused(1, 1, T0 + 5)));
  check('anything beats nothing, nothing beats nothing', isNewer(paused(1, 1), null) && !isNewer(null, paused(1, 1)));
  check('level duration uses minutes', levelDurationMs(LEVELS, 4) === 8 * MIN && levelDurationMs(LEVELS, 99) === 0);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
