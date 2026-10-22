// Synced clock engine: pure math, no imports, no DOM, no network.
// Design: docs/timer-prd/07-synced-clock.md (Part 4, "The clock function").
//
// A game's state is an anchor, not a ticking counter: "at server time
// anchorAt there were remainingMs left on level levelIndex, and the clock was
// running|paused". Every screen derives the current time from that, so a
// screen that hears about a change late still lands on the same time, and
// level rollovers need nobody to press anything.
//
// All times are server-time milliseconds (Date.now() + measured offset).
// Test: node scripts/clock-engine-test.js

export const STATUSES = ['running', 'paused'];
export const ACTIONS = ['start', 'pause', 'toggle', 'addMinute', 'subtractMinute', 'next', 'prev', 'reset'];
const MINUTE_MS = 60000;

export function levelDurationMs(levels, index) {
  const level = levels[index];
  return level ? Math.round(Number(level.duration) * MINUTE_MS) : 0;
}

export function initialGame(levels, now) {
  return {
    levelIndex: 0,
    status: 'paused',
    remainingMs: levelDurationMs(levels, 0),
    anchorAt: now,
    changedAt: now,
    startedTonight: false
  };
}

// Clamp state read from Firestore or localStorage. Returns null when the
// record can't be trusted, so callers fall back to initialGame().
export function normalizeGame(raw, levels) {
  if (!raw || typeof raw !== 'object' || !levels || !levels.length) return null;
  const levelIndex = Number(raw.levelIndex);
  const remainingMs = Number(raw.remainingMs);
  const anchorAt = Number(raw.anchorAt);
  const changedAt = Number(raw.changedAt);
  if (!Number.isInteger(levelIndex) || levelIndex < 0 || levelIndex >= levels.length) return null;
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
  if (!Number.isFinite(anchorAt) || !Number.isFinite(changedAt)) return null;
  if (!STATUSES.includes(raw.status)) return null;
  const game = {
    levelIndex,
    status: raw.status,
    remainingMs,
    anchorAt,
    changedAt,
    startedTonight: raw.startedTonight === true
  };
  if (raw.noHold === true) game.noHold = true;
  return game;
}

// True when state a should replace state b: the newest press wins.
export function isNewer(a, b) {
  if (!a) return false;
  if (!b) return true;
  return a.changedAt >= b.changedAt;
}

// Where the clock is at server time `now`.
//   phase 'running'  counting down
//   phase 'paused'   stopped mid-level (or before the first start)
//   phase 'holding'  a break ran out: sitting at the start of the next level,
//                    full time, waiting for the director to press start
//   phase 'finished' the last level reached 0:00
export function clockAt(game, levels, now) {
  const last = levels.length - 1;
  let levelIndex = game.levelIndex;
  let remainingMs = game.remainingMs;

  if (game.status === 'running') {
    let elapsed = Math.max(0, now - game.anchorAt);
    // Each pass consumes one level, so levels.length passes is always enough.
    for (let guard = 0; guard <= levels.length; guard++) {
      if (elapsed < remainingMs) {
        return result(levels, levelIndex, remainingMs - elapsed, 'running');
      }
      elapsed -= remainingMs;
      if (levelIndex >= last) {
        return result(levels, last, 0, 'finished');
      }
      const ended = levels[levelIndex];
      levelIndex += 1;
      remainingMs = levelDurationMs(levels, levelIndex);
      if (ended.isBreak) {
        // Breaks stop at the end and wait for the director (timer.html
        // nextRound after a break): the next level, paused, at full time.
        return result(levels, levelIndex, remainingMs, 'holding');
      }
    }
    return result(levels, last, 0, 'finished');
  }

  if (levelIndex >= last && remainingMs <= 0) {
    return result(levels, last, 0, 'finished');
  }
  // Paused at full time on the level after a break reads as "waiting after
  // the break", unless the director got here with Prev (noHold): stepping
  // back onto that level is not a break that just ended.
  const prev = levels[levelIndex - 1];
  if (prev && prev.isBreak && !game.noHold && remainingMs === levelDurationMs(levels, levelIndex)) {
    return result(levels, levelIndex, remainingMs, 'holding');
  }
  return result(levels, levelIndex, remainingMs, 'paused');
}

// Same clock, re-anchored at `now` and stamped as the newest change. Used when
// a TV comes back from Local mode: its clock becomes the one everyone follows.
export function rebaseGame(game, levels, now) {
  const at = clockAt(game, levels, now);
  const rebased = {
    levelIndex: at.levelIndex,
    status: at.phase === 'running' ? 'running' : 'paused',
    remainingMs: at.remainingMs,
    anchorAt: now,
    changedAt: now,
    startedTonight: game.startedTonight === true
  };
  if (game.noHold === true && at.phase === 'paused') rebased.noHold = true;
  return rebased;
}

function result(levels, levelIndex, remainingMs, phase) {
  return { levelIndex, remainingMs, phase, level: levels[levelIndex] };
}

// The new game state after a control press at server time `now`. Always
// starts from where the clock really is (clockAt), never from the stored
// anchor, so a press made after several silent rollovers lands correctly.
export function applyAction(game, levels, action, now) {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown clock action: ${action}`);
  const last = levels.length - 1;
  const at = clockAt(game, levels, now);
  const next = {
    levelIndex: at.levelIndex,
    status: at.phase === 'running' ? 'running' : 'paused',
    remainingMs: at.remainingMs,
    anchorAt: now,
    changedAt: now,
    startedTonight: game.startedTonight === true
  };

  switch (action) {
    case 'toggle':
      return applyAction(game, levels, next.status === 'running' ? 'pause' : 'start', now);
    case 'start':
      next.status = 'running';
      next.startedTonight = true;
      break;
    case 'pause':
      next.status = 'paused';
      break;
    case 'addMinute':
      next.remainingMs += MINUTE_MS;
      break;
    case 'subtractMinute':
      next.remainingMs = Math.max(0, next.remainingMs - MINUTE_MS);
      break;
    case 'next':
      if (next.levelIndex < last) {
        next.levelIndex += 1;
        next.remainingMs = levelDurationMs(levels, next.levelIndex);
        next.status = 'paused';
      }
      break;
    case 'prev':
      if (next.levelIndex > 0) {
        next.levelIndex -= 1;
        next.remainingMs = levelDurationMs(levels, next.levelIndex);
        next.status = 'paused';
        // Every other action builds a fresh object without this flag, so it
        // lasts only until the next press.
        next.noHold = true;
      }
      break;
    case 'reset':
      return initialGame(levels, now);
  }
  return next;
}
