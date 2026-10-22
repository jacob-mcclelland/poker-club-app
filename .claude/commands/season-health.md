---
name: season-health
description: >
  Run a data health check on all active poker seasons (both venues by default).
  Detects anomalies in bounty records, check-in data, and attendance counts
  before they cause scoring errors or reporting problems. Can be run at any
  point during the season. Usage: /season-health (both venues) or /season-health Wild Corgi (one venue)
---

## What this does

Runs `scripts/season_health.py` against live Firestore data (or the
emulator, when `FIRESTORE_EMULATOR_HOST` is set; see CLAUDE.md) and applies
judgment to the output — distinguishing real problems from expected patterns,
grouping related flags, and suggesting likely root causes.

## Steps

1. **Determine venues.** Use the argument if provided (single venue). Default: both venues.

2. **Run the script.**

```bash
# Both venues (default):
python scripts/season_health.py

# Single venue:
python scripts/season_health.py "Wild Corgi"
```

The script returns an array when both venues are audited, or a single object for one venue.

3. **Read the JSON output and reason over it** before printing anything.
   Apply the following judgment rules:

   - **over_capacity**: Always a hard error. Single game > 46 is impossible
     given venue constraints. Either a data entry error or a bounty inflation
     problem (check for duplicates on the same date).

   - **bounty_checkin_discrepancy**: Error if diff > 5. Cross-reference with
     duplicate_bounty_record flags on the same date — they usually have the
     same root cause. If both fire on the same date/game, note the connection.

   - **duplicate_bounty_record**: Always a hard error. This is the most
     likely cause of inflated bounty counts. Note which player(s) are duped
     and by how much.

   - **implausible_individual_bounty**: Warning — requires context. A count
     of 9 in a 32-player game is plausible (skilled player, lucky night).
     A count of 9 in a 15-player game is not. Flag clearly if game size is
     small; note it as "worth reviewing" if game size is large.

   - **no_bounty_data**: Warning. Could mean the game was cancelled, or
     bounties simply weren't entered yet. Note whether the game date is in
     the past (problem) or future (expected).

   - **no_checkin_data**: Warning. Same reasoning as above.

4. **Print the report** in this exact format. When both venues are audited, print one block per venue back to back:

```
═══ SEASON HEALTH — [venue] • [season.name] ([startDate] – [championshipDate]) ═══

Checked : [today's date]
Schedule: [count] games  ([list of dates with type, one per line indented])

── ERRORS ([count]) ──────────────────────────────────────────────────────
[if 0: "  ✓ None"]
[else for each error:]
  ✗ [check type in plain English]  [date]  Game [gameNum]
    [detail]
    [if related flags exist: "→ Related: [other flag on same date]"]

── WARNINGS ([count]) ────────────────────────────────────────────────────
[if 0: "  ✓ None"]
[else for each warning:]
  ⚠ [check type in plain English]  [date]
    [detail]

── SUMMARY ───────────────────────────────────────────────────────────────
[if total == 0:]
  ✓ Season data looks clean. No anomalies found.
[else:]
  [count] error(s) need attention before invoicing.
  [count] warning(s) worth reviewing.
  [if any errors: "Run /audit-scores [venue] to check if scoring was affected."]

══════════════════════════════════════════════════════════════════════════
```

5. **After the report**, if there are errors, add a brief plain-English
   paragraph (2–4 sentences) with your read on the most likely root cause
   and what to investigate first. Skip this if everything is clean.

## Check type → plain English labels

- `over_capacity`              → Attendance over capacity
- `bounty_checkin_discrepancy` → Bounty/checkin mismatch
- `duplicate_bounty_record`    → Duplicate bounty entry
- `implausible_individual_bounty` → Suspicious individual bounty count
- `no_bounty_data`             → Missing bounty data
- `no_checkin_data`            → Missing check-in data
