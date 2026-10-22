// Exercises the pure shot receipt reopen selector in public/shots-reopen.js.
// No DOM, storage, or network. Run: node scripts/shots-reopen-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The module is browser ESM; strip the export keywords and evaluate it.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'shots-reopen.js'), 'utf8')
  .replace(/^export const /mg, 'const ')
  .replace(/^export function /mg, 'function ');
const { REOPEN_MS, pickReopenCard } = new Function(src + '\n return { REOPEN_MS, pickReopenCard };')();

const NOW = 1760000000000;
const CLIENT_ID = 'device-a';
const SENT_AT = NOW - 5 * 60 * 1000;
const CARD = { id: 'round-1', clientId: CLIENT_ID, status: 'pending' };
function options(overrides = {}) {
  return {
    lastSent: { id: CARD.id, sentAt: SENT_AT, sessionDate: '2026-10-16', venue: 'Tight End', table: 'spade' },
    cards: [CARD],
    sessionDate: '2026-10-16',
    venue: 'Tight End',
    clientId: CLIENT_ID,
    now: NOW,
    ...overrides
  };
}

let failures = 0;
function check(name, fn) {
  try {
    assert.strictEqual(fn(), true);
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}${err && err.message ? ` -> ${err.message}` : ''}`);
  }
}
function reopens(overrides) {
  return pickReopenCard(options(overrides)) === CARD;
}

check('sent 5 minutes ago reopens', () => reopens({}));
check('exactly 30 minutes reopens', () => reopens({ lastSent: { ...options().lastSent, sentAt: NOW - REOPEN_MS } }));
check('31 minutes does not reopen', () => !reopens({ lastSent: { ...options().lastSent, sentAt: NOW - REOPEN_MS - 1 } }));
check('future sentAt does not reopen', () => !reopens({ lastSent: { ...options().lastSent, sentAt: NOW + 1 } }));
check('other session date does not reopen', () => !reopens({ lastSent: { ...options().lastSent, sessionDate: '2026-10-15' } }));
check('other venue does not reopen', () => !reopens({ venue: 'Wild Corgi' }));
check('empty stored venue still reopens', () => reopens({ lastSent: { ...options().lastSent, venue: '' } }));
check('empty current venue still reopens', () => reopens({ venue: '' }));
check('other device clientId does not reopen', () => !reopens({ clientId: 'device-b' }));
check('card missing from feed does not reopen', () => !reopens({ cards: [] }));
check('forceNew does not reopen', () => !reopens({ forceNew: true }));
check('draftResumed does not reopen', () => !reopens({ draftResumed: true }));
check('poured and closed card still reopens', () => {
  const closedCard = { ...CARD, status: 'closed', poured: true, paid: true, closed: true };
  return pickReopenCard(options({ cards: [closedCard] })) === closedCard;
});
check('missing lastSent does not reopen', () => !reopens({ lastSent: null }));
check('lastSent without an id does not reopen', () => !reopens({ lastSent: { ...options().lastSent, id: '' } }));
check('custom datesMatch is used', () => reopens({
  lastSent: { ...options().lastSent, sessionDate: 'custom-night' },
  datesMatch: (a, b) => a === 'custom-night' && b === '2026-10-16'
}));

if (failures) {
  console.log(`FAIL ${failures} of 16 cases`);
  process.exitCode = 1;
} else {
  console.log('PASS all 16 cases');
}
