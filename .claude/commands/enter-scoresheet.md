---
name: enter-scoresheet
description: >
  Enter and finalize a tournament game from a photo of the handwritten
  scoresheet. The owner sends a picture of the sheet plus which game it is; Claude
  reads names, placements and bounties off it, matches every name against
  the live Firestore roster, asks about anything that doesn't resolve,
  drives director.html through the Claude in Chrome extension to enter
  bounties and eliminations, runs the pre-check, finalizes, and verifies
  the result in Firestore. Use when the owner sends a scoresheet photo, says
  "enter this game", "close out game 2", "here's the sheet", or invokes
  /enter-scoresheet. Usage: /enter-scoresheet [date] [venue] [game]
---

## What this does

Turns a photo of the paper scoresheet into a finalized game. The photo
tells you **which** game; the database tells you **who played**. Never
trust a cold read of handwriting over the roster.

This writes scoring data to production. Every step that commits is gated
on the owner's confirmation. Established 2026-08-29 (8/27 Wild Corgi Game 2 went
in clean on the first pass after four clarifying questions).

## The pattern

**photo -> match against Firestore -> ask about what doesn't resolve -> enter -> pre-check -> finalize -> verify**

The asking is not overhead. Handwriting alone does not identify a player;
the roster does. Nicknames, a first name plus an initial, and a first name
shared by two checked-in players are all normal on a sheet, and roster
matching resolves them where reading harder cannot.

## Prerequisites

**Check the browser connection FIRST, before reading the sheet.** Call
`list_connected_browsers` at the very start. If it returns empty, say so
immediately and ask the owner to open Chrome, rather than doing the whole read
and match and then discovering there is nowhere to enter it.

- **Claude in Chrome extension** connected, and Chrome signed in to
  director.html as staff. The sign-in is a one-time gate that persists.
  If `list_connected_browsers` shows nothing, ask the owner to open Chrome.
- If the director page renders data but staff calls fail, the owner is **not**
  signed in. A populated page proves nothing (it renders from public
  reads). Check auth state, do not infer it. If the Sign In dialog
  appears, stop and ask the owner to click "Sign In with Google" themselves.
- Credentials for the scripts: application-default credentials for the
  live project, or the Firestore emulator in this copy (see "Running the
  commands in this copy" in CLAUDE.md).

## Steps

### 1. Identify the game

From the photo and the owner's message, get **date** (`M/D/YYYY`), **venue**
(`Tight End` or `Wild Corgi`), and **game number**. If the photo does
not show these, ask before doing anything else. Arguments to the command
override the photo.

### 2. Pull the live roster and current state

```bash
cd functions && node scripts/game-state.js "8/27/2026" "Wild Corgi" 2 2>&1 | grep -v Deprecation | grep -v trace-dep
```

Confirm the game is empty (no eliminations, no bounties). If it already
has entries, stop and show the owner what is there; this is a correction, not a
clean entry, and needs a different conversation.

### 3. Read the sheet and match every row

Build a table: **row / your writing / my match / bounties / placement**.
Match each handwritten name against the CHECKED IN list first, then the
full player list:

```bash
cd functions && node scripts/game-state.js --search "fen,drew,kendal" 2>&1 | grep -v Deprecation | grep -v trace-dep
```

Mark each match `confirmed`, `probable` (say why), or `unknown`. Known
traps:

- Two players sharing a first name spelled two ways (Kendal Corrimore /
  Kendall Dellacourt).
  Never pick one silently.
- Nicknames and partial surnames ("Fenny", "Drew B", "Riley P").
- Substring search matches inside words ("hill" hits Uma Umberhill).
- Two checked-in players whose first names differ by one letter
  (Jesse Wexmoor / Jessie Hollowmere). Read the surname before choosing.
- Duplicate player records for one person, one bare first name and one
  full name ("Remy" and "Remy Larkspurne"). Use whichever is checked in
  for the game, and report the duplicate as a follow-up.
- Names spelled with odd casing in /players ("Shay pellbrook", "Val Q").
  Use the stored spelling exactly when typing into the director page.

**Placement sanity check:** the placement column must contain each of
1 through 10 exactly once. If it does, say so; it is strong evidence the
column was read correctly. If not, flag which numbers are missing or
doubled.

**Bounty column: read every digit back to the owner, without exception.** Do not
flag only the ones you doubt. Your confidence on these digits is not
calibrated and the numbers feed the venue's weekly report. Present all ten and
get an explicit confirmation or correction for each before entering.

What reading the digits back is for (2026-09-02):

- **The owner's handwritten `2` looks like a `6`.** If you are about to write
  a 6, check it; it is probably a 2.
- A digit you read *confidently* gets the same read-back as one you doubt.
  Flagging only your doubts does not catch the confident misreads.

Also print the total and compare it against the same night's other game
as a plausibility check.

**Players who placed but are not checked in:** list them. They will
still score, but they need to be checked in first so attendance credits.

### 4. Ask, then wait

Present the table and a numbered list of every unresolved item:
unknown names, ambiguous names, shaky bounty digits, scratched-out
marks, placed-but-not-checked-in players. **Do not enter anything until
The owner answers.** When the owner confirms, restate the final ten rows (place, player,
bounties) and the bounty total once more; a "yep" on that is the go.

### 5. Check in any missing players

On director.html, select the date+venue and game number, then use the
check-in search box to add each placed player who was not on the roster.
Type a prefix of the stored name, pick the match from the dropdown, and
confirm. Re-run the state script if unsure the count moved.

### 6. Enter bounties

Bounties are entered per player on the director page. For each of the
ten, open the player's bounty control, type the count, save. Take a
screenshot after the last one and compare every count to the confirmed
table before moving on. Print the total and confirm it matches.

### 7. Enter eliminations

Enter placements in whatever order the page requires. **Every
elimination raises a confirm dialog naming the player and the place**
("Sage Fenwhistle finished 3rd?"). Read that text and verify it against the
confirmed table before clicking confirm. That dialog is the check on your
click coordinates; use it, do not trust the click.

After all ten, scroll to the results preview and compare it row by row
to the confirmed table.

### 8. Pre-check and finalize

Click Save Results. The pre-check returns a verdict:

- `LOOKS FULL`: no warnings. Finalize.
- `PARTIAL`: warnings listed. **Show every warning to the owner and ask** before
  ticking the acknowledgement. A warning like "unconverted RSVP" is a real
  fork: if that player did play, finalizing first means correcting a
  scored game instead of a pending one.
- `BLOCK`: stop, report the blocker, do not finalize.

**Never click "Finalize anyway."** That is the fail-open path shown when
the verification call itself fails (usually auth, though the dialog blames
the network). It writes scoring while skipping the check and logs the
submission as unverified. If you see it, cancel and fix the auth problem.

### 9. Verify in Firestore, not the success screen

```bash
cd functions && node scripts/game-state.js "8/27/2026" "Wild Corgi" 2 --verify 2>&1 | grep -v Deprecation | grep -v trace-dep
```

Expected for a full top 10 with no ties: 10 eliminations, all
`processed`, none with null points, bonus total 535, bounty total equal
to the confirmed sheet total, check-in count equal to roster plus any
players added in step 5.

### 10. Report

Print the final table (place, player, points, bounties) and the verify
line items. State plainly what was written and what, if anything, was
left out. List any leftover oddities noticed along the way (duplicate
check-in docs, RSVP no-shows) as follow-ups, not as things you fixed.

## Do not

- Enter a name you matched by guess. Ask.
- Tick a pre-check acknowledgement without showing the owner the warning.
- Click "Finalize anyway."
- Add any bypass, token, or unauthenticated path to the app to make this
  easier. The ops path is your own gcloud credentials plus the owner's Chrome
  session, nothing more.
- Treat a rendered director page as proof of being signed in.
