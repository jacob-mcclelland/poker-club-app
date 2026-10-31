'use strict';
// Player name resolution. The roster is messy on purpose (case and spacing
// variants, first-name-only rows, typos), so a lookup never guesses:
//   - an exact match after trimming, collapsing spaces and lowercasing, or an
//     exact alias match, resolves;
//   - anything else is `unknown_player`, with the closest names as
//     suggestions for the agent to offer back, never silently substituted.
// A resolved name also reports near-duplicate roster rows, so an agent can
// say "this looks like the same person as X" instead of hiding it.

const { ToolError } = require('./errors');

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function near(a, b) {
  if (a === b) return false;
  if (lev(a, b) <= 1) return true;
  const [fa, ...ra] = a.split(' '), [fb, ...rb] = b.split(' ');
  if (fa !== fb) return false;
  const la = ra.join(' '), lb = rb.join(' ');
  return a.startsWith(b) || b.startsWith(a) || (la && lb && lev(la, lb) <= 2);
}

/** Build the name index once per data load. */
function buildIndex(data) {
  const gameRows = {};  // norm name -> { display -> count }
  for (const c of ['checkins', 'eliminations', 'bounties', 'rsvps']) {
    for (const r of data[c]) {
      if (!r.player) continue;
      const k = norm(r.player);
      gameRows[k] = gameRows[k] || {};
      gameRows[k][r.player] = (gameRows[k][r.player] || 0) + 1;
    }
  }
  const people = new Map(); // norm name -> { key, display, rosterIds, aliases }
  const add = (k, display) => { if (!people.has(k)) people.set(k, { key: k, display, rosterIds: [], aliases: [] }); return people.get(k); };
  for (const [k, variants] of Object.entries(gameRows)) {
    const display = Object.entries(variants).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    add(k, display);
  }
  for (const p of data.players) {
    const k = norm(p.name);
    if (!k) continue;
    const person = add(k, p.name.trim().replace(/\s+/g, ' '));
    person.rosterIds.push(p.id);
    for (const a of p.aliases || []) person.aliases.push(a);
  }
  const aliasMap = new Map(); // norm alias -> [person keys]
  for (const person of people.values()) for (const a of person.aliases) {
    const k = norm(a);
    aliasMap.set(k, [...(aliasMap.get(k) || []), person.key]);
  }
  return { people, aliasMap, hasGames: (k) => !!gameRows[k] };
}

/**
 * Resolve free text to one person.
 * @returns {{ name, key, matchedBy, rosterIds, possibleDuplicates }}
 */
function resolvePlayer(index, input) {
  const q = norm(input);
  if (!q) throw new ToolError('invalid_argument', 'player is required.');
  let person = index.people.get(q);
  let matchedBy = person ? (person.display === String(input).trim() ? 'exact' : 'normalized') : null;
  if (!person && index.aliasMap.has(q)) {
    const keys = [...new Set(index.aliasMap.get(q))];
    if (keys.length > 1) {
      throw new ToolError('ambiguous_player', `"${input}" is an alias of more than one player.`, { candidates: keys.map(k => index.people.get(k).display) });
    }
    person = index.people.get(keys[0]);
    matchedBy = 'alias';
  }
  if (!person) {
    const suggestions = [...index.people.values()]
      .map(p => ({ p, d: lev(q, p.key) }))
      .filter(({ p, d }) => d <= 3 || near(q, p.key))
      .sort((a, b) => (index.hasGames(b.p.key) - index.hasGames(a.p.key)) || a.d - b.d || a.p.display.localeCompare(b.p.display))
      .slice(0, 3).map(({ p }) => p.display);
    throw new ToolError('unknown_player', `No player named "${input}" in the roster or game records.`, { suggestions });
  }
  const possibleDuplicates = [...index.people.values()]
    .filter(p => near(person.key, p.key))
    .map(p => p.display).sort();
  return { name: person.display, key: person.key, matchedBy, rosterIds: person.rosterIds, possibleDuplicates };
}

module.exports = { buildIndex, resolvePlayer, norm, lev };
