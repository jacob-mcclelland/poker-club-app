// Runs admin/game-inspector.html's own updateRank and updateBounty against a
// fake adminEditGameRecord whose replies can land in any order, the way two
// quick edits can on a slow phone. No DOM, storage, or network.
// Run: node scripts/game-inspector-edit-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'game-inspector.html'), 'utf8')
  .replace(/\r\n/g, '\n');
const grab = name => {
  const m = page.match(new RegExp(`    window\\.${name} = async function\\(i, val\\) \\{[\\s\\S]*?\\n    \\};\\n`));
  if (!m) throw new Error(`${name} not found in game-inspector.html`);
  return m[0];
};

// A server that applies each call only when the test completes it.
function makeWorld(initialRows) {
  const rows = { eliminations: Object.assign({}, initialRows.eliminations), bounties: Object.assign({}, initialRows.bounties) };
  const pending = [];
  let minted = 0;
  const editGameRecord = (data) => new Promise(resolve => {
    pending.push(() => {
      if (data.op === 'setRank') {
        if (data.rank) { rows.eliminations[data.elimId] = data.rank; resolve({ data: { elimId: data.elimId } }); }
        else { if (data.elimId) delete rows.eliminations[data.elimId]; resolve({ data: { elimId: null } }); }
      } else if (data.op === 'setBounty') {
        if (data.count > 0) { rows.bounties[data.bountyId] = data.count; resolve({ data: { bountyId: data.bountyId } }); }
        else { if (data.bountyId) delete rows.bounties[data.bountyId]; resolve({ data: { bountyId: null } }); }
      }
    });
  });
  const sandbox = {
    window: {},
    roster: [],
    editGameRecord,
    gameRow: p => ({ venue: 'V', date: '1/1/2026', gameNum: 1, player: p.name }),
    newRowId: col => `${col}-new-${++minted}`,
    toast: () => {},
    render: () => {}
  };
  new Function('s', `with (s) { ${grab('updateRank')} ${grab('updateBounty')} }`)(sandbox);
  return { rows, pending, sandbox };
}
const settle = () => new Promise(r => setImmediate(r));

let failures = 0, total = 0;
async function check(name, fn) {
  total++;
  try {
    assert.strictEqual(await fn(), true);
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}${err && err.message ? ` -> ${err.message}` : ''}`);
  }
}

(async () => {
  await check('clear a rank, pick a new one, replies in reverse: the new rank survives', async () => {
    const w = makeWorld({ eliminations: { e1: 3 } });
    w.sandbox.roster.push({ name: 'Test Player', elimId: 'e1', rank: 3 });
    const a = w.sandbox.window.updateRank(0, '');      // clear
    const b = w.sandbox.window.updateRank(0, '5');     // pick again before the clear lands
    w.pending[1](); await settle();                    // the pick lands first
    w.pending[0](); await settle();                    // then the clear
    await Promise.all([a, b]);
    const ranks = Object.values(w.rows.eliminations);
    return ranks.length === 1 && ranks[0] === 5 && w.rows.eliminations[w.sandbox.roster[0].elimId] === 5;
  });
  await check('two quick picks on an unranked player leave one row', async () => {
    const w = makeWorld({ eliminations: {} });
    w.sandbox.roster.push({ name: 'Test Player', elimId: null, rank: null });
    const a = w.sandbox.window.updateRank(0, '2');
    const b = w.sandbox.window.updateRank(0, '4');
    w.pending[1](); await settle();
    w.pending[0](); await settle();
    await Promise.all([a, b]);
    return Object.keys(w.rows.eliminations).length === 1;
  });
  await check('clear a bounty, set a new count, replies in reverse: the new count survives', async () => {
    const w = makeWorld({ bounties: { b1: 2 } });
    w.sandbox.roster.push({ name: 'Test Player', bountyId: 'b1', bounties: 2 });
    const a = w.sandbox.window.updateBounty(0, '0');
    const b = w.sandbox.window.updateBounty(0, '3');
    w.pending[1](); await settle();
    w.pending[0](); await settle();
    await Promise.all([a, b]);
    const counts = Object.values(w.rows.bounties);
    return counts.length === 1 && counts[0] === 3;
  });
  await check('two quick bounty counts on a player without one leave one row', async () => {
    const w = makeWorld({ bounties: {} });
    w.sandbox.roster.push({ name: 'Test Player', bountyId: null, bounties: 0 });
    const a = w.sandbox.window.updateBounty(0, '1');
    const b = w.sandbox.window.updateBounty(0, '2');
    w.pending[1](); await settle();
    w.pending[0](); await settle();
    await Promise.all([a, b]);
    return Object.keys(w.rows.bounties).length === 1;
  });
  await check('changing an existing rank edits that same row', async () => {
    const w = makeWorld({ eliminations: { e1: 3 } });
    w.sandbox.roster.push({ name: 'Test Player', elimId: 'e1', rank: 3 });
    const a = w.sandbox.window.updateRank(0, '1');
    w.pending[0](); await settle();
    await a;
    return w.rows.eliminations.e1 === 1 && Object.keys(w.rows.eliminations).length === 1;
  });

  if (failures) {
    console.log(`FAIL ${failures} of ${total} cases`);
    process.exit(1);
  } else {
    console.log(`PASS all ${total} cases`);
  }
})();
