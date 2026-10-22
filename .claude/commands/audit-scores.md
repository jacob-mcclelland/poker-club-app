---
name: audit-scores
model: claude-haiku-4-5
description: >
  Audit All-In Poker Club season scores for correctness. Runs the
  auditSeasonPoints function against the live Firebase app, compares
  current leaderboard against the corrected scoring logic, and prints
  a diff report. Use this whenever you need to verify scores are correct,
  after a game night, after a code change, or any time the leaderboard
  looks suspicious. Accepts an optional venue argument (defaults to
  "Tight End"). Usage: /audit-scores or /audit-scores Wild Corgi
---

## What this does

Navigates to the live app in Chrome, calls `auditSeasonPoints` via the
firebase-api.js module, and prints a structured diff report showing:
- Players whose scores differ between live and corrected logic
- Why each excluded record was dropped
- A clean summary

This is read-only. No data is changed.

In this copy there is no live site; this command needs the pages pointed at
the emulators first (see Limits in README.md).

## Steps

1. **Get a browser tab.** Use `tabs_context_mcp` to find an existing tab,
   or `tabs_create_mcp` if none exist. Navigate it to:
   `https://poker-club.example/leaderboard.html`
   Wait for navigation to complete before running JS.

2. **Determine the venue.** Use the argument passed to this command if
   provided. Default to `"Tight End"` if none given.

3. **Run the audit.** Execute this JavaScript in the tab:

```js
(async () => {
  const mod = await import('./firebase-api.js?v=' + Date.now());
  const result = await mod.default.auditSeasonPoints({ venue: '__VENUE__' });
  return {
    season:        result.season,
    changed:       result.changed.map(p => ({ name: p.name, live: p.livePoints, fixed: p.auditPoints, delta: p.delta })),
    excludedCount: result.excludedCount,
    excludedBreakdown: (() => {
      const tally = {};
      result.excluded.forEach(r => { tally[r.reason] = (tally[r.reason] || 0) + 1; });
      return tally;
    })(),
    totalPlayers:  result.players.length,
    cleanCount:    result.players.length - result.changed.length,
  };
})()
```

Replace `__VENUE__` with the actual venue name before executing.

4. **Print the report** using exactly this format — keep it tight, no
   filler prose:

```
═══ SCORE AUDIT — [venue] • [season.name] ([season.startDate] – [season.endDate]) ═══

Players checked : [totalPlayers]
Clean (no delta): [cleanCount]
Scores differ   : [changed.length]
Records excluded: [excludedCount]

── Exclusion breakdown ──────────────────────────────
[for each reason: "  reason : count"]

── Score changes ────────────────────────────────────
[if changed.length === 0]
  ✓ All scores match. No corrections needed.
[else for each changed player, sorted by |delta| desc]
  [name]  [live] → [fixed]  ([delta with sign, e.g. -10])
[end]

══════════════════════════════════════════════════════
```

5. **If any scores differ**, add a one-line note after the report:
   > Scores are shown as (live → corrected). The leaderboard is already
   > displaying the corrected values — no data action needed unless a new
   > bug is suspected.

6. **If the JS call errors**, report the error message clearly and suggest
   checking whether the function is deployed (`firebase deploy --only
   functions:auditSeasonPoints`).

## What the numbers mean

- **delta negative** — the stored records give more points than the audited
  logic. The leaderboard already shows the audited value.
- **delta positive** — live score is lower than it should be. Investigate
  immediately — this would mean the eligibility logic is over-filtering.
- **"date outside season window"** — record's date didn't parse or falls
  outside the season's startDate–endDate. Expected for historical carryover.
- **"player has elimination for same game"** — attendance checkin suppressed
  because the player also placed; prevents double-counting.
- **"season mismatch"** — record carries an explicit season number that
  doesn't match the current season.

## Token discipline

Keep your response to the report block only. No preamble, no recap of how
the audit works, no suggestions unless delta > 0 or an error occurs.
