---
name: player-sweep
description: >
  Sweep the All-In Poker roster for duplicate player names, junk rows, and
  never-seen entries, then merge or delete only what the owner confirms. Nothing in
  the app does this; the sweep and the writes both run as scripts against
  Firestore (live, or the emulator in this copy; see CLAUDE.md). Use when the owner says "run the player sweep", "clean up
  duplicates", "merge these names", or invokes /player-sweep. Usage:
  /player-sweep (report + guided cleanup) or /player-sweep report (read-only)
---

## What this does

Two scripts under `functions/scripts/`, both run from the `functions/` directory:

- `player-sweep.js` — READ-ONLY. Loads the roster and every game record,
  proposes duplicate groups with evidence, and lists junk rows, never-seen
  rows, and config names that don't resolve to a roster entry.
- `player-merge.js` — the only writer. Mirrors the app's own `mergePlayers`
  and `deletePlayer` exactly. Every call is a dry run unless `--yes` is passed.

This writes to production data when confirmed. The rule is simple: **one
confirmation per group, from the owner, in this conversation, before any `--yes`.**
Never batch confirmations ("do all of them"); ask group by group. Never
merge on similarity alone; the evidence has to make sense as one person.

## Steps

1. **Run the sweep.**

```bash
cd functions && node scripts/player-sweep.js --text
```

   If the argument is `report`, print the summary in step 3 and stop.

2. **Read the groups and apply judgment before showing anything.** For each
   group decide: *same person* / *different people* / *can't tell*.

   - **Same person** signals: one spelling has almost all the activity and the
     other is a one-off; the small one appeared once around the same dates and
     venue; nickname or single-letter difference; one row is a GAS import with
     zero activity and the other is live.
   - **Different people** signals: both spellings have steady activity across
     overlapping dates; both have check-ins on the *same date and venue* (two
     rows for one night is either two people or a double-entry, and either way
     it is not a plain merge); different last names with a shared first name.
   - **Can't tell**: ask the owner. Give the counts and dates, not a recommendation.

   Suggested canonical is the spelling with the most activity. Override it
   when the fuller spelling is obviously right (e.g. "Quinn" → "Quinn T" is
   backwards if "Quinn T" has 40 check-ins and "Quinn" has 1, but the sweep
   already sorts by activity, so mostly trust it).

3. **Print the report** in this format:

```
═══ PLAYER SWEEP — [date] ═══
Roster: [n] rows · [n] GAS imports · [n] never seen · [n] junk

── PROPOSED MERGES ([count]) ─────────────────────────────
#1  keep "Avery Sablewood"  ← merge "Averie Sablewood"
    Avery Sablewood   42 check-ins  6 places  Tight End   3/4/2026 → 8/27/2026
    Averie Sablewood   1 check-in   0 places  Tight End   7/16/2026
    why: nickname/initial match (95)
    read: same person — one-off spelling on 7/16

#2  ...

── NOT PROPOSING ([count]) ───────────────────────────────
  Finley Orrinsby / Lane Orrinsby — different first names, both active. Two people.
  Quinn — could be Quinn T or Quinn Wexmoor; ask before touching.

── JUNK ROWS ([count]) ───────────────────────────────────
  "Admin 1" (0 records), " " (0 records) — safe to delete

── NEVER SEEN ([count], [n] GAS imports) ─────────────────
  [count only, plus the non-GAS ones by name — those were added by hand recently]

── CONFIG NAMES NOT ON ROSTER ([count]) ──────────────────
  config/autoQualifiers.tightEnd[2]: "Marlow Yarrowdale"  ← will need a hand edit after merge
══════════════════════════════════════════════════════════
```

4. **Ask the owner group by group.** For a handful, use AskUserQuestion with the
   proposed merge as the recommended option. For a longer list (first-name-only
   rows, the 85 tier), the owner prefers a numbered list in chat and replies with the
   numbers to apply or decline. Junk rows can be confirmed as one batch since
   they carry no records.

   **When the owner declines a pair, add it to `scripts/player-sweep-ignore.json`**
   so the sweep never proposes it again. A declined pair is a decision, not a
   maybe.

5. **For each confirmed group, dry-run then apply.** Show the dry-run line
   count, then run with `--yes`:

```bash
cd functions && node scripts/player-merge.js --into "Avery Sablewood" --from "Averie Sablewood"
cd functions && node scripts/player-merge.js --into "Avery Sablewood" --from "Averie Sablewood" --yes
```

   Junk: `node scripts/player-merge.js --delete "Admin 1" --yes`. The script
   refuses to delete a row that has game records unless `--force`; do not use
   `--force` without telling the owner what records would be orphaned.

6. **Re-run the sweep** and confirm the merged names are gone from the groups
   list. Then, if any config names were flagged, list them for the owner to fix in
   the app (auto-qualifiers page, seasons page) — the script does not touch
   config docs on purpose, same as the app.

7. **Log it.** Append one line per applied change to
   `docs/player-sweep-log.md` (create if missing): date, action, names,
   records touched. This is the only record of who was merged into whom.

## Never-seen rows

217 of 556 roster rows had zero activity at the 2026-09-03 audit, 351 rows
are GAS imports. Do not propose deleting never-seen rows in the normal sweep;
they are harmless and some are real people who only RSVP'd before RSVP was
tracked. Only raise them if the owner asks for a roster purge, and then only the GAS
imports with no email, as one explicit batch.

## Gotchas

- `mergePlayers` in the app and this script both rewrite `player` and
  `playerLower` on records but leave `scoringEvents` alone (write-only ledger,
  nothing reads it) and leave config docs alone. Standings recompute from the
  rewritten records on the next leaderboard load; no re-finalize needed.
- The leaderboard keys on `playerLower`. A merge is visible in standings
  immediately.
- Records written by the admin game inspector have no `playerLower`. The
  merge script falls back to matching on `player` for those.
- `--rename OLD --to NEW` is just a merge into a name that does not exist yet.
