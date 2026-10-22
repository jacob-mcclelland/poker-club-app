// Checks which game the player app's clock bubble points at (public/clock-pick.js).
// Rule (the owner, 2026-10-20): Game 1 before 9:00 PM Denver time, Game 2 from 9:00 PM
// when Game 2's clock started tonight; otherwise the other started game.
// No DOM, no network. Run: node scripts/clock-pick-test.js
const fs = require('fs');
const path = require('path');

// Both modules are browser ESM; strip exports and imports and evaluate them together.
const strip = (s) => s.replace(/^import .*$/mg, '').replace(/^export (const|function) /mg, '$1 ');
const engine = strip(fs.readFileSync(path.join(__dirname, '..', 'public', 'clock-engine.js'), 'utf8'));
const pick = strip(fs.readFileSync(path.join(__dirname, '..', 'public', 'clock-pick.js'), 'utf8'));
const { pickFrom, denverMinutes, mainGameFor } = new Function(engine + '\n' + pick + '\n return { pickFrom, denverMinutes, mainGameFor };')();

// A Denver wall-clock time on Tue 2026-10-20 (MDT, UTC-6) as epoch ms.
const at = (h, m) => Date.UTC(2026, 9, 20, h + 6, m);
const levels = [{ name: 'L1', minutes: 20, small: 100, big: 200 }, { name: 'L2', minutes: 20, small: 200, big: 400 }];
const game = (status, changedAt) => ({ levelIndex: 0, status, remainingMs: 600000, anchorAt: changedAt, changedAt, startedTonight: true });
const doc = (games) => ({ structure: { levels }, games });

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${got}, want ${want}`); }
}
const pickOf = (docs, now) => { const p = pickFrom(docs, now); return p ? `${p.venue}/${p.game}` : 'none'; };

check('denverMinutes 8:59 PM', denverMinutes(at(20, 59)), 20 * 60 + 59);
check('denverMinutes 9:00 PM', denverMinutes(at(21, 0)), 21 * 60);

const both = { tight: doc({ 1: game('running', at(19, 0)), 2: game('running', at(21, 0)) }) };
check('8:59 PM, both running -> Game 1', pickOf(both, at(20, 59)), 'tight/1');
check('9:00 PM, both running -> Game 2', pickOf(both, at(21, 0)), 'tight/2');
check('10:30 PM, both running -> Game 2', pickOf(both, at(22, 30)), 'tight/2');

const g2paused = { tight: doc({ 1: game('running', at(19, 0)), 2: game('paused', at(20, 55)) }) };
check('9:05 PM, Game 2 started but paused, Game 1 running -> Game 2', pickOf(g2paused, at(21, 5)), 'tight/2');

const onlyG1 = { tight: doc({ 1: game('running', at(19, 0)) }) };
check('9:30 PM, Game 2 not started -> Game 1', pickOf(onlyG1, at(21, 30)), 'tight/1');

const onlyG2 = { tight: doc({ 2: game('running', at(18, 55)) }) };
check('7:00 PM, only Game 2 started -> Game 2', pickOf(onlyG2, at(19, 0)), 'tight/2');

const twoBars = { tight: doc({ 1: game('paused', at(18, 0)) }), corgi: doc({ 1: game('running', at(19, 0)) }) };
check('7:05 PM, Game 1 at two bars -> the running one', pickOf(twoBars, at(19, 5)), 'corgi/1');

const stale = { tight: doc({ 1: game('running', at(19, 0) - 13 * 3600 * 1000) }) };
check('stale game from a previous night -> none', pickOf(stale, at(19, 30)), 'none');


// Clock Control opens on one clock's main game (mainGameFor).
const ctrl = (d, now) => mainGameFor(d, levels, now);
check('control 8:59 PM, both started -> 1', ctrl(both.tight, at(20, 59)), '1');
check('control 9:00 PM, Game 2 started -> 2', ctrl(both.tight, at(21, 0)), '2');
check('control 9:05 PM, Game 2 paused but started -> 2', ctrl(g2paused.tight, at(21, 5)), '2');
check('control 9:30 PM, Game 2 not started -> 1', ctrl(onlyG1.tight, at(21, 30)), '1');
check('control 7:00 PM, only Game 2 started -> 1 (before 9 PM)', ctrl(onlyG2.tight, at(19, 0)), '1');
check('control 9:30 PM, Game 2 from a previous night -> 1', ctrl(doc({ 2: game('running', at(21, 0) - 13 * 3600 * 1000) }), at(21, 30)), '1');
check('control 9:30 PM, no clock doc yet -> 1', ctrl(null, at(21, 30)), '1');
check('control 1:00 AM after midnight -> 1', ctrl(both.tight, Date.UTC(2026, 9, 21, 7, 0)), '1');

console.log(`${pass} of ${pass + fail} passed`);
process.exit(fail ? 1 : 0);
