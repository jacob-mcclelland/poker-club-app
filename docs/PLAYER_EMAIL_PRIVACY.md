# Player email privacy migration

## Problem

Player email addresses have been written to `players/{playerId}`. Firestore rules allow signed-out clients, including the kiosk and player app, to read player documents, so those email addresses are publicly readable.

## Change

Email addresses and their `emailAddedAt` timestamps are stored in `playerContacts/{playerId}`. Cloud Functions and Admin SDK scripts can read and write this collection. Firestore rules explicitly deny all client reads and writes. The existing `emailList` behavior remains unchanged.

The migration script keeps the original email and timestamp in a local JSON backup, copies each backed-up email to `playerContacts`, reads the contact back to verify it, then clears `email` and `emailAddedAt` from the player document. It clears only verified rows. A contact with a different email is skipped to protect a newer contact write, and the final verification and clear use a transaction to catch concurrent changes.

## Deploy and migrate

Run these steps from the app root. Do not run the migration until the rules and Functions changes are deployed.

1. Deploy Firestore rules and Functions:

   ```powershell
   firebase deploy --only firestore:rules,functions
   ```

2. Review the migration counts without changing Firestore:

   ```powershell
   node functions/scripts/migrate-player-emails.js --dry-run
   ```

3. Create and retain a local backup file:

   ```powershell
   node functions/scripts/migrate-player-emails.js --backup .\player-email-backup.json
   ```

   The file contains one object per player with an email: `playerId`, `name`, `email`, and `emailAddedAt`. Store it securely because it contains personal information.

4. Apply the migration using that backup:

   ```powershell
   node functions/scripts/migrate-player-emails.js --apply --backup .\player-email-backup.json
   ```

   `--apply` requires a backup path. If the file does not yet exist, the script creates it before writing Firestore. If it already exists, the script uses it as the migration input. A differing email already in `playerContacts` is skipped and must be reviewed. The script prints counts for copied, verified, cleared, and skipped rows.

5. Verify the result. Confirm `copied`, `verified`, and `cleared` match, `skipped` is zero, and a fresh dry run reports zero players with email. Spot-check that the corresponding `playerContacts/{playerId}` documents contain the expected email and that `players/{playerId}` no longer contains `email` or `emailAddedAt`.

The script automatically uses the Firestore emulator when `FIRESTORE_EMULATOR_HOST` is set. Run a dry run against an emulator before applying to production.

## Rollback

Use the retained backup JSON from an Admin SDK script after normal initialization to merge the saved fields back into each `players/{playerId}` document. The timestamp is stored as `{seconds, nanoseconds}`; reconstruct it as a Firestore `Timestamp` when present:

```js
const rows = require('./player-email-backup.json');
async function restorePlayerEmails() {
  for (const row of rows) {
    const fields = { email: row.email };
    if (row.emailAddedAt) {
      fields.emailAddedAt = new admin.firestore.Timestamp(
        row.emailAddedAt.seconds,
        row.emailAddedAt.nanoseconds
      );
    }
    await admin.firestore().collection('players').doc(row.playerId).set(fields, { merge: true });
  }
}
restorePlayerEmails().catch(console.error);
```

Keep the backup until the rollback window closes. Restoring player fields makes those emails readable under the existing public player rules, so coordinate the code and rules rollback with the data restore.
