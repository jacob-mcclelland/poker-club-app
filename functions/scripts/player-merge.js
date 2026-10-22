/**
 * Roster write tool for the /player-sweep command. Mirrors the exact write
 * shapes of mergePlayers and deletePlayer in functions/index.js, so running
 * this is the same as an admin doing it through the app, minus the dead UI.
 *
 * Usage (from All-In-Poker-App/functions):
 *   node scripts/player-merge.js --into "Megan Larche" --from "Meghan Larche" [--from "..."]
 *   node scripts/player-merge.js --delete "Admin 1" [--force]
 *   node scripts/player-merge.js --rename "Old Name" --to "New Name"
 *
 * Every mode is a DRY RUN unless --yes is passed. Dry run prints exactly
 * which documents would change and exits 0 without writing.
 *
 * What a merge does (same as mergePlayers):
 *   - checkins / eliminations / bounties / rsvps whose playerLower matches a
 *     --from name get player + playerLower rewritten to the --into name
 *   - each --from roster row is deleted
 *   - the --into roster row is created if it does not exist
 * What it does NOT touch (same as the app): scoringEvents (write-only ledger),
 * config/* docs and champ_overrides (names stored as plain strings). The sweep
 * report lists config names that no longer resolve; fix those by hand.
 *
 * Delete refuses if the row has any checkin/elimination/bounty unless --force
 * (same rule as deletePlayer). Rename is a merge where the --into name is new.
 */
const admin = require('firebase-admin');
process.env.GCLOUD_PROJECT = 'demo-poker';
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'demo-poker' });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const opts = n => args.map((a, i) => a === n ? args[i + 1] : null).filter(Boolean);
const YES = flag('--yes');
const lower = s => String(s || '').trim().toLowerCase();

async function findRoster(name) {
  const byLower = await db.collection('players').where('nameLower', '==', lower(name)).get();
  if (!byLower.empty) return byLower.docs;
  // Legacy rows may lack nameLower; fall back to a scan on name.
  const all = await db.collection('players').get();
  return all.docs.filter(d => lower(d.data().name) === lower(name));
}

async function recordsFor(nameLower, nameAsTyped) {
  const out = {};
  for (const col of ['checkins', 'eliminations', 'bounties', 'rsvps']) {
    const byLower = await db.collection(col).where('playerLower', '==', nameLower).get();
    const seen = new Set(byLower.docs.map(d => d.id));
    const docs = byLower.docs.slice();
    // Older records (GAS imports, game-inspector direct writes, early kiosk
    // rows) have no playerLower. Match on the player string as typed AND
    // lowercased; both spellings exist in the data.
    for (const literal of new Set([nameAsTyped, nameLower].filter(Boolean))) {
      const byName = await db.collection(col).where('player', '==', literal).get().catch(() => ({ docs: [] }));
      byName.docs.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); } });
    }
    out[col] = docs;
  }
  return out;
}

async function commitInChunks(ops) {
  // Firestore batches cap at 500 writes.
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(fn => fn(batch));
    await batch.commit();
  }
}

async function merge(into, froms) {
  const intoName = into.trim(), intoLower = lower(into);
  const ops = []; const summary = [];
  for (const from of froms) {
    const fromLower = lower(from);
    if (fromLower === intoLower) { summary.push(`skip "${from}": same as target`); continue; }
    const rosterDocs = await findRoster(from);
    // Scan records under every spelling that normalizes to this name, not just
    // the roster row's nameLower, so legacy spellings on records come along.
    const recs = await recordsFor(fromLower, from.trim());
    const n = Object.values(recs).reduce((s, d) => s + d.length, 0);
    summary.push(`"${from}" → "${intoName}": roster rows ${rosterDocs.length}, checkins ${recs.checkins.length}, eliminations ${recs.eliminations.length}, bounties ${recs.bounties.length}, rsvps ${recs.rsvps.length}`);
    if (rosterDocs.length === 0 && n === 0) { summary.push(`  WARNING: nothing found for "${from}"`); continue; }
    for (const col of Object.keys(recs)) recs[col].forEach(d => ops.push(b => b.update(d.ref, { player: intoName, playerLower: intoLower, mergedFrom: from, mergedAt: FieldValue.serverTimestamp() })));
    rosterDocs.forEach(d => ops.push(b => b.delete(d.ref)));
  }
  const intoDocs = await findRoster(intoName);
  if (intoDocs.length === 0) {
    summary.push(`roster row for "${intoName}" does not exist — will be created`);
    ops.push(b => b.set(db.collection('players').doc(), { name: intoName, nameLower: intoLower, createdAt: FieldValue.serverTimestamp(), addedVia: 'player-sweep' }));
  }
  summary.forEach(s => console.log(s));
  console.log(`${ops.length} document writes ${YES ? 'COMMITTING' : '(dry run — add --yes to apply)'}`);
  if (YES) { await commitInChunks(ops); console.log('done'); }
}

async function del(name) {
  const docs = await findRoster(name);
  if (docs.length === 0) { console.log(`no roster row named "${name}"`); return; }
  const recs = await recordsFor(lower(name), name.trim());
  const has = recs.checkins.length + recs.eliminations.length + recs.bounties.length;
  console.log(`"${name}": roster rows ${docs.length}, checkins ${recs.checkins.length}, eliminations ${recs.eliminations.length}, bounties ${recs.bounties.length}, rsvps ${recs.rsvps.length}`);
  if (has && !flag('--force')) { console.log('BLOCKED: has game records. Merge it into the right name instead, or pass --force to delete the roster row only (records stay).'); return; }
  console.log(`${docs.length} roster row(s) ${YES ? 'DELETING' : '(dry run — add --yes to apply)'}`);
  if (YES) { await commitInChunks(docs.map(d => b => b.delete(d.ref))); console.log('done'); }
}

/**
 * Collapse roster rows and record spellings that differ only by whitespace
 * or case ("Jacob McClelland " vs "Jacob McClelland") onto one canonical
 * string. Keeps the roster row with the most data (email, aliases), deletes
 * the rest, rewrites any record whose player string is not byte-identical.
 */
async function dedupe(name) {
  const canonical = name.trim(), canonLower = lower(name);
  const normKey = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const all = await db.collection('players').get();
  const rows = all.docs.filter(d => normKey(d.data().name) === normKey(canonical));
  if (rows.length === 0) { console.log(`no roster row normalizes to "${canonical}"`); return; }
  const contactDocs = await Promise.all(rows.map(d => db.collection('playerContacts').doc(d.id).get()));
  const emailByPlayerId = new Map(contactDocs.map((contact, i) => [
    rows[i].id,
    (contact.exists && contact.data().email) || rows[i].data().email || null
  ]));
  const emailFor = d => emailByPlayerId.get(d.id) || d.data().email || null;
  const richness = d => { const x = d.data(); return (emailFor(d) ? 4 : 0) + (Array.isArray(x.aliases) && x.aliases.length ? 2 : 0) + (x.name === canonical ? 1 : 0); };
  rows.sort((a, b) => richness(b) - richness(a));
  const keep = rows[0], drop = rows.slice(1);
  const ops = [];
  if (keep.data().name !== canonical || keep.data().nameLower !== canonLower) ops.push(b => b.update(keep.ref, { name: canonical, nameLower: canonLower }));
  drop.forEach(d => ops.push(b => b.delete(d.ref)));
  let rewrites = 0;
  for (const col of ['checkins', 'eliminations', 'bounties', 'rsvps']) {
    const snap = await db.collection(col).select('player', 'playerLower').get();
    snap.docs.forEach(d => {
      const x = d.data();
      if (normKey(x.player) === normKey(canonical) && (x.player !== canonical || x.playerLower !== canonLower)) {
        ops.push(b => b.update(d.ref, { player: canonical, playerLower: canonLower, mergedFrom: x.player, mergedAt: FieldValue.serverTimestamp() }));
        rewrites++;
      }
    });
  }
  console.log(`"${canonical}": ${rows.length} roster rows → keep ${keep.id} (${JSON.stringify(keep.data().name)}${emailFor(keep) ? ', has email' : ''}), delete ${drop.length}; ${rewrites} record spellings to rewrite`);
  console.log(`${ops.length} document writes ${YES ? 'COMMITTING' : '(dry run — add --yes to apply)'}`);
  if (YES) { await commitInChunks(ops); console.log('done'); }
}

(async () => {
  const into = opt('--into'), froms = opts('--from'), delName = opt('--delete'), ren = opt('--rename'), to = opt('--to'), dd = opt('--dedupe');
  const delId = opt('--delete-id');
  if (delId) {
    // Roster rows with a blank/whitespace name cannot be addressed by name.
    const d = await db.collection('players').doc(delId).get();
    if (!d.exists) { console.log(`no roster row with id ${delId}`); process.exit(1); }
    console.log(`roster ${delId} name=${JSON.stringify(d.data().name)} ${YES ? 'DELETING' : '(dry run — add --yes to apply)'}`);
    if (YES) { await d.ref.delete(); console.log('done'); }
  }
  else if (dd) await dedupe(dd);
  else if (into && froms.length) await merge(into, froms);
  else if (ren && to) await merge(to, [ren]);
  else if (delName) await del(delName);
  else { console.log('usage: --into NAME --from NAME [--from NAME]... | --rename OLD --to NEW | --dedupe NAME | --delete NAME [--force]   (add --yes to write)'); process.exit(2); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
