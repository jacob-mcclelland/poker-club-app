/**
 * Move email fields from players/{playerId} to playerContacts/{playerId}.
 *
 * Usage:
 *   node scripts/migrate-player-emails.js --dry-run
 *   node scripts/migrate-player-emails.js --backup ../player-email-backup.json
 *   node scripts/migrate-player-emails.js --apply --backup ../player-email-backup.json
 *
 * --apply requires --backup. If that path does not exist, this run creates a
 * backup there before writing Firestore. If it exists, it is used as input.
 */
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

const args = process.argv.slice(2);
const hasFlag = name => args.includes(name);
const backupFlagIndex = args.indexOf('--backup');
const backupArg = backupFlagIndex >= 0 ? args[backupFlagIndex + 1] : null;
const APPLY = hasFlag('--apply');
const projectId = process.env.GCLOUD_PROJECT || 'demo-poker';

if (backupFlagIndex >= 0 && (!backupArg || backupArg.startsWith('--'))) {
  throw new Error('--backup requires a file path.');
}
if (APPLY && hasFlag('--dry-run')) {
  throw new Error('Choose either --apply or --dry-run, not both.');
}
if (APPLY && !backupArg) {
  throw new Error('--apply requires --backup <file>.');
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--backup') { i++; continue; }
  if (!['--apply', '--dry-run'].includes(args[i])) {
    throw new Error(`Unknown argument: ${args[i]}`);
  }
}

process.env.GCLOUD_PROJECT = projectId;
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId
});

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const backupPath = backupArg ? path.resolve(process.cwd(), backupArg) : null;
const hasEmail = value => typeof value === 'string' && value.trim().length > 0;

function timestampForBackup(value) {
  if (!value) return null;
  if (value instanceof Date) value = Timestamp.fromDate(value);
  if (value && typeof value.toDate === 'function') {
    return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
    return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  return null;
}

function timestampFromBackup(value) {
  if (value && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return Timestamp.fromDate(date);
  }
  return FieldValue.serverTimestamp();
}

function backupRowsFromSnapshot(snapshot) {
  return snapshot.docs
    .filter(doc => hasEmail(doc.data().email))
    .map(doc => {
      const data = doc.data();
      return {
        playerId: doc.id,
        name: data.name || '',
        email: data.email,
        emailAddedAt: timestampForBackup(data.emailAddedAt)
      };
    });
}

function writeNewBackup(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), { encoding: 'utf8', flag: 'wx' });
}

function readBackup(file) {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Backup must contain a JSON array.');
  const seen = new Set();
  rows.forEach((row, index) => {
    if (!row || typeof row.playerId !== 'string' || !row.playerId || !hasEmail(row.email)) {
      throw new Error(`Invalid backup row at index ${index}; expected playerId and email.`);
    }
    if (seen.has(row.playerId)) throw new Error(`Duplicate playerId in backup: ${row.playerId}`);
    seen.add(row.playerId);
  });
  return rows;
}

async function runDryRun() {
  const [players, contacts] = await Promise.all([
    db.collection('players').get(),
    db.collection('playerContacts').get()
  ]);
  const rows = backupRowsFromSnapshot(players);
  const contactIds = new Set(contacts.docs.map(doc => doc.id));
  const alreadyCopied = rows.filter(row => contactIds.has(row.playerId)).length;

  console.log(`Players with email: ${rows.length}`);
  console.log(`Already have a playerContacts document: ${alreadyCopied}`);
  if (backupPath) {
    writeNewBackup(backupPath, rows);
    console.log(`Backup written: ${backupPath} (${rows.length} rows)`);
  }
  console.log('Dry run complete; no Firestore data changed.');
}

async function runApply() {
  let rows;
  if (fs.existsSync(backupPath)) {
    rows = readBackup(backupPath);
    console.log(`Using existing backup: ${backupPath} (${rows.length} rows)`);
  } else {
    const players = await db.collection('players').get();
    rows = backupRowsFromSnapshot(players);
    writeNewBackup(backupPath, rows);
    console.log(`Backup created before migration: ${backupPath} (${rows.length} rows)`);
  }

  let copied = 0;
  let verified = 0;
  let cleared = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const playerRef = db.collection('players').doc(row.playerId);
    const contactRef = db.collection('playerContacts').doc(row.playerId);
    try {
      const copyResult = await db.runTransaction(async transaction => {
        const [playerBefore, contactBefore] = await Promise.all([
          transaction.get(playerRef),
          transaction.get(contactRef)
        ]);
        if (!playerBefore.exists) return { copied: false, reason: 'player document is missing' };

        const currentEmail = playerBefore.data().email;
        if (hasEmail(currentEmail) && currentEmail !== row.email) {
          return { copied: false, reason: 'player email differs from the backup' };
        }

        const contactData = contactBefore.exists ? contactBefore.data() : {};
        const existingContactEmail = contactData.email;
        if (hasEmail(existingContactEmail) && existingContactEmail !== row.email) {
          return { copied: false, reason: 'contact email differs from the backup' };
        }

        const contactUpdate = {};
        if (!hasEmail(existingContactEmail)) {
          contactUpdate.email = row.email;
          contactUpdate.source = 'migration';
        }
        if (!contactBefore.exists || !contactData.emailAddedAt) {
          contactUpdate.emailAddedAt = timestampFromBackup(row.emailAddedAt);
        }
        if (Object.keys(contactUpdate).length > 0) {
          transaction.set(contactRef, contactUpdate, { merge: true });
        }
        return { copied: true };
      });
      if (!copyResult.copied) {
        skipped++;
        console.error(`Skipped ${row.playerId}: ${copyResult.reason}.`);
        continue;
      }
      copied++;

      const contactAfter = await contactRef.get();
      if (!contactAfter.exists || contactAfter.data().email !== row.email) {
        skipped++;
        console.error(`Skipped ${row.playerId}: contact email did not verify.`);
        continue;
      }
      verified++;

      const clearResult = await db.runTransaction(async transaction => {
        const [playerBeforeClear, contactBeforeClear] = await Promise.all([
          transaction.get(playerRef),
          transaction.get(contactRef)
        ]);
        if (!playerBeforeClear.exists) {
          return { cleared: false, reason: 'player document disappeared before clearing' };
        }
        if (!contactBeforeClear.exists || contactBeforeClear.data().email !== row.email) {
          return { cleared: false, reason: 'contact email changed before clearing' };
        }
        const latestEmail = playerBeforeClear.data().email;
        if (hasEmail(latestEmail) && latestEmail !== row.email) {
          return { cleared: false, reason: 'player email changed before clearing' };
        }
        transaction.update(playerRef, {
          email: FieldValue.delete(),
          emailAddedAt: FieldValue.delete()
        });
        return { cleared: true };
      });
      if (!clearResult.cleared) {
        skipped++;
        console.error(`Skipped ${row.playerId}: ${clearResult.reason}.`);
        continue;
      }
      cleared++;
    } catch (error) {
      failed++;
      console.error(`Failed ${row.playerId}: ${error.message}`);
    }
  }

  if (skipped > 0 || failed > 0) process.exitCode = 1;
  console.log(`Migration counts: copied=${copied}, verified=${verified}, cleared=${cleared}, skipped=${skipped}, failed=${failed}`);
}

async function main() {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.log(`Firestore emulator: ${process.env.FIRESTORE_EMULATOR_HOST} (project ${projectId})`);
  } else {
    console.log(`Firestore project: ${projectId}`);
  }
  if (APPLY) await runApply();
  else await runDryRun();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
