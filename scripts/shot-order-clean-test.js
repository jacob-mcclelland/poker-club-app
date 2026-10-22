// Exercises public/shot-order-clean.js, and checks that bar.html and
// shots.html clean every shotRounds document before rendering it.
// No DOM, storage, or network. Run: node scripts/shot-order-clean-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').replace(/\r\n/g, '\n');

// The module is browser ESM; strip the export keyword and evaluate it.
const { cleanOrder } = new Function(
  pub('shot-order-clean.js').replace(/^export function /mg, 'function ') + '\n return { cleanOrder };')();

// bar.html's own signature and totals functions, the first code that walks
// players and shots on every snapshot.
const barSrc = pub('bar.html');
const grab = name => barSrc.match(new RegExp(`  function ${name}\\(o\\) \\{[\\s\\S]*?\\n  \\}\\n`))[0];
const { orderSig, orderTotals } = new Function(grab('orderSig') + grab('orderTotals') + '\n return { orderSig, orderTotals };')();

let failures = 0, total = 0;
function check(name, fn) {
  total++;
  try {
    assert.strictEqual(fn(), true);
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}${err && err.message ? ` -> ${err.message}` : ''}`);
  }
}
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };

const malformed = {
  status: 'pending', venue: 'Tight End',
  players: [null, 7, ['x'], { name: 'Sam', payment: 'card', shots: [null, { type: 'House', qty: '2' }, 'x', { type: 9, qty: null, note: 3 }] }],
  submitter: 'nobody'
};

check('a malformed order breaks bar.html orderSig as written', () => throws(() => orderSig(malformed)));
check('the cleaned order passes through orderSig', () => !throws(() => orderSig(cleanOrder(malformed))));
check('the cleaned order passes through orderTotals', () => {
  const t = orderTotals(cleanOrder(malformed));
  return t.House === 2 && t['9'] === 0;
});
check('non-object players and shots are dropped', () => {
  const o = cleanOrder(malformed);
  return o.players.length === 1 && o.players[0].shots.length === 2;
});
check('names, types and notes become strings, qty a number', () => {
  const s = cleanOrder(malformed).players[0].shots[1];
  return s.type === '9' && s.qty === 0 && s.note === '3';
});
check('a non-object submitter becomes { name: "" }', () => cleanOrder(malformed).submitter.name === '');
check('a well-formed order keeps every field', () => {
  const good = { status: 'pending', table: 'hearts', clientId: 'c1', submitter: { name: 'Sam' },
    players: [{ name: 'Sam', payment: 'cash', shots: [{ type: 'House', qty: 1, note: 'salt' }] }] };
  return JSON.stringify(cleanOrder(good)) === JSON.stringify(good);
});
check('a document that is not an object yields an empty order', () => {
  const o = cleanOrder(null);
  return Array.isArray(o.players) && o.players.length === 0;
});
check('bar.html cleans each snapshot document', () =>
  /import \{ cleanOrder \} from '\.\/shot-order-clean\.js\?v=\d+'/.test(barSrc)
  && /snap\.docs\s*\n?\s*\.map\(d => \(\{ id: d\.id, data: cleanOrder\(d\.data\(\)\) \}\)\)/.test(barSrc));
check('shots.html cleans each snapshot document', () => {
  const src = pub('shots.html');
  return /import \{ cleanOrder \} from '\.\/shot-order-clean\.js\?v=\d+'/.test(src)
    && /liveCards = snap\.docs\.map\(d => \(\{ id: d\.id, \.\.\.cleanOrder\(d\.data\(\)\) \}\)\)/.test(src);
});

if (failures) {
  console.log(`FAIL ${failures} of ${total} cases`);
  process.exit(1);
} else {
  console.log(`PASS all ${total} cases`);
}
