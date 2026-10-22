#!/usr/bin/env node
// Dump the live Firestore state for one game: eliminations, bounties, check-ins.
// Used by the /enter-scoresheet command before (roster) and after (verify) entry.
//
// Usage (from the functions/ directory):
//   node scripts/game-state.js "8/27/2026" "Wild Corgi" 2
//   node scripts/game-state.js "8/27/2026" "Wild Corgi" 2 --verify
//   node scripts/game-state.js --search "fen,drew,kendal"   (substring search of /players)
//
// Auth: application-default credentials, or the Firestore emulator when
// FIRESTORE_EMULATOR_HOST is set (see CLAUDE.md).

const admin = require('firebase-admin');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-poker';
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const BONUS = { 1: 90, 2: 85, 3: 80, 4: 70, 5: 60, 6: 50, 7: 40, 8: 30, 9: 20, 10: 10 };
const EXPECTED_BONUS_TOTAL = Object.values(BONUS).reduce((a, b) => a + b, 0); // 535

const args = process.argv.slice(2);
const live = (snap) => snap.docs.map((d) => d.data()).filter((d) => d.status !== 'removed');

async function search(terms) {
  const s = await db.collection('players').get();
  const all = s.docs.map((d) => d.data().name).filter(Boolean);
  for (const t of terms) {
    const hits = all.filter((n) => n.toLowerCase().includes(t.toLowerCase()));
    console.log(t.padEnd(10) + ' -> ' + (hits.length ? hits.join(' | ') : '(none)'));
  }
}

async function state(date, venue, gameNum, verify) {
  const q = (c) =>
    db.collection(c).where('date', '==', date).where('venue', '==', venue).where('gameNum', '==', gameNum).get();
  const [es, cs, bs] = await Promise.all([q('eliminations'), q('checkins'), q('bounties')]);
  const el = live(es).sort((a, b) => a.rank - b.rank);
  const bo = live(bs);
  const ck = live(cs);

  console.log(`=== ${date} ${venue} Game ${gameNum} ===`);
  console.log(`eliminations (non-removed): ${el.length}`);
  let bonusTotal = 0;
  el.forEach((d) => {
    bonusTotal += d.bonusPoints || 0;
    console.log(`  ${String(d.rank).padStart(2)}. ${String(d.player).padEnd(22)} ${String(d.status).padEnd(10)} pts=${d.bonusPoints}`);
  });
  const bountyTotal = bo.reduce((s, d) => s + (d.count || 0), 0);
  console.log(`bounty docs: ${bo.length}  total=${bountyTotal}`);
  bo.forEach((d) => console.log(`  ${String(d.player).padEnd(22)} ${d.count}`));
  console.log(`\n=== CHECKED IN (${ck.length}) ===`);
  ck.map((d) => d.player).sort().forEach((p) => console.log('  ' + p));

  if (verify) {
    const allProcessed = el.every((d) => d.status === 'processed');
    const allPts = el.every((d) => typeof d.bonusPoints === 'number');
    const ranks = el.map((d) => d.rank).sort((a, b) => a - b).join(',');
    console.log('\n=== VERIFY ===');
    console.log(`elims=${el.length} (expect 10)  ranks=${ranks}`);
    console.log(`all processed=${allProcessed}  all have pts=${allPts}`);
    console.log(`bonus total=${bonusTotal} (expect ${EXPECTED_BONUS_TOTAL} for a full top 10 with no ties)`);
    console.log(`bounty total=${bountyTotal}`);
    console.log(`active checkins=${ck.length}  attendanceOnly=${ck.filter((d) => d.attendanceOnly === true).length}`);
    const placedNotCheckedIn = el.map((d) => d.player).filter((p) => !ck.some((c) => c.player === p));
    if (placedNotCheckedIn.length) console.log(`PLACED BUT NOT CHECKED IN: ${placedNotCheckedIn.join(', ')}`);
  }
}

(async () => {
  try {
    if (args[0] === '--search') {
      await search((args[1] || '').split(',').map((s) => s.trim()).filter(Boolean));
    } else {
      const [date, venue, gameNum] = args;
      if (!date || !venue || !gameNum) {
        console.error('usage: node scripts/game-state.js <M/D/YYYY> <venue> <gameNum> [--verify] | --search a,b,c');
        process.exit(2);
      }
      await state(date, venue, Number(gameNum), args.includes('--verify'));
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
  process.exit(0);
})();
