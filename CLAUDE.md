# All-In Poker Club App — Claude Context

Rewritten 2026-09-05 from a live audit. The previous version of this file
described a Google Apps Script backend that was retired on 2026-06-18. If
something here disagrees with the code, the code wins; update this file.

## What this is

League management for two bar poker venues, **Tight End** (Tuesdays) and
**Wild Corgi** (Thursdays). Two games a night. Players check in, directors
score the final table, standings and bounties feed a season leaderboard and
the venues' weekly reports.

Firebase project `demo-poker` in this copy, which exists only in the
emulators. The live project id and address are not included.

## Architecture

```
public/            static pages on Firebase Hosting (no build step, no framework)
  firebase-api.js  the ONE shared client module: PokerAPI (callable wrappers +
                   a few direct Firestore reads), PlayerSearch (name matching),
                   PokerSession (dates, game windows), PokerRealtime (listeners)
  staff-auth.js    requireStaff() gate for staff pages
  admin/admin-auth.js  requireAdmin() gate for admin pages
functions/index.js  all Cloud Functions (v2, Node 20, ~5,700 lines)
functions/scripts/  admin-SDK scripts run by hand or by Claude commands;
                    excluded from the deploy bundle by firebase.json
Firestore           source of truth for everything
```

There is no Google Sheet, no Apps Script, no Netlify. `syncedToGAS` and
`importedFromGAS` are field names left over from the migration; the
`syncedToGAS: true` flag on a checkin is a LIVE marker (attendance-only
row that finalize must skip). Do not remove it.

## Pages by audience

**Players** (`index.html` is the catch-all rewrite target): schedule, RSVP,
standings, phone self check-in, "add me" roster button. Also `home.html`
(marketing), `announcements.html`, `stats.html`, `shots.html` (drink orders).

**Staff** (hub `gameday.html`, role staff or admin):
- `checkin.html` — venue kiosk
- `director.html` — final-table scoring and finalize. **Do not change this
  page without the owner asking; everyone is trained on it.**
- `tonight.html` — who RSVP'd / who's here per game, credit-a-player
  (+10 attendance on any night, including finalized ones), unfinalized
  alert, tonight's shot rounds. Added 2026-09-04; replaces `dashboard.html`.
- `staff/timer.html` — venue clock. `timer-bombpot` / `timer-pocketqueenz`
  are event-themed variants. Since 2026-10-14 the clock is shared through
  Firestore `timerClocks/{venue}` (design: `docs/timer-prd/07-synced-clock.md`):
  `clock-engine.js` is the pure clock math (`node scripts/clock-engine-test.js`),
  `clock-sync.js` the server-time offset and Firestore mirror, and
  `functions` `serverTime` behind `/api/server-time`. The TV is local-first:
  it runs with no network, and its menu has a Shared / Local only switch.
  `staff/timer-classic.html` is an untouched copy of the pre-sync timer,
  kept as the game-night fallback. Do not edit it.
  Phone pages on the same shared clock (built 2026-10-14, step 2 and 3):
  `staff/clock-control.html?venue=` (staff controller: clock buttons, Hand
  of the Night, TV layout and refresh via `tv.layoutSeq` / `tv.refreshSeq`)
  and `/clock?venue=` (`clock.html`, public player view: dim/bright, opt-in
  sounds, keep-awake, tap to light). Shared labels in `clock-view.js`.
  Sounds (2026-10-15): the controller's Voice calls / Chimes switch sets
  `timerClocks/{id}.sound` for every phone; a phone only turns sound on or
  off. Voice plays the owner's recordings in `public/sounds/calls/` (mapped by
  blinds in `clock.html` BLIND_CLIPS); unrecorded moments chime.
- `championship-director.html`, `auto-qualifiers.html` — championship night
- `new-players.html` — first-seen report
- `bar.html`, `bar-qr.html` — bartender board

**Admin** (hub `admin/index.html`, role admin): `seasons`, `schedule`,
`event-publisher`, `content` (three editors for the same event record —
collapse pending), `players` (really accounts & roles), `game-inspector`
(writes through the admin-only `adminEditGameRecord` function since
2026-10-19),
`jackpots`, `comms`, `shot-log`.

Ten tiny root and `staff/` files are redirect shims for old bookmarks and
printed QR codes. Leave them.

**Club contests (`/contest`, added 2026-10-08).** The live app also serves an
event contest app (a separate repository) under `/contest`, with a round
button on the home page while voting is open. Neither is included in this
copy.

## Roles

`userProfiles/{uid}` with `role: 'admin' | 'staff'` (plus legacy `isAdmin` /
`isStaff` booleans). Server side: `requireRole(request, ['staff'])` or
`['admin']` at the top of a callable. Ungated on purpose: `checkin`,
`removeCheckin`, `rsvp`, `addPlayer`, `getDailyStats`, `getLiveScoring`,
`getLeaderboard`, `getSchedule` (drafts need admin), `emailSignup`,
`updatePlayerEmail`.

**Firestore security rules are deployed and enforced** (since 2026-09-05).
`firestore.rules` is wired into `firebase.json`; access matrix in
`docs/FIRESTORE_RULES_PROPOSAL.md`. Any collection not listed there is
denied, so a new collection needs a rule and
`firebase deploy --only firestore:rules`. Callable gates still guard every
Cloud Function (the Admin SDK bypasses rules).

## Scoring model (the part that must not drift)

- `checkins`, `eliminations`, `bounties`, `rsvps` keyed by `player`,
  `playerLower`, `date` (M/D/YYYY), `venue`, `gameNum` (1|2).
- `finalizeGame` stamps each row: eliminations get `bonusPoints` +
  `status: 'processed'`; non-placing checkins get `attendanceOnly: true`.
  There is no game-level "finalized" document.
- `getLeaderboard` recomputes from raw rows every call. Attendance counts
  only rows with `attendanceOnly == true`. Placement points already include
  the 10 attendance points.
- Late adds after finalize: `checkin` now detects processed eliminations and
  sets `attendanceOnly` itself (2026-09-04). `addAttendanceCredit` is the
  explicit "give them their 10" path and is what Tonight's credit box calls.
- Points table `BONUS_POINTS` {90,85,80,70,60,50,40,30,20,10} + 10
  attendance. Ties: average, round up to nearest 5 (`calculateTiePoints`).
  The table is duplicated in director, dashboard, game-inspector — keep them
  equal until it is hoisted.
- Three record formats coexist in `getLeaderboard` (GAS-synced with
  `totalPoints`, director with `bonusPoints`, old import where `rank > 10`
  means total). Historical seasons depend on this branch.
- **Venue headcounts come from bounties**, not checkins (bounties record
  who actually played).

## Roster

`players/{id}` with `name`, `nameLower`, `aliases`. Emails live in
`playerContacts/{id}`, which only the server can read (since 2026-10-16,
`docs/PLAYER_EMAIL_PRIVACY.md`).
`checkin`, `rsvp`, and `addPlayer` all create a roster row from free text,
so typos become players. Cleanup is a Claude command, not app code:
`/player-sweep` (scripts `player-sweep.js` read-only, `player-merge.js`
writes, `player-sweep-ignore.json` declined pairs, log in
`docs/player-sweep-log.md`).

## Deploy contract

```bash
cd poker-club-app
FUNCTIONS_DISCOVERY_TIMEOUT=60000 firebase deploy --only "functions:<name>" --force
firebase deploy --only hosting
```

- Deploy single functions by name. `functions/index.js` takes ~11 s to load
  on this machine, over the CLI's 10 s default, hence the env var.
- **Release cadence (the owner, 2026-10-14):** hosting deploys go out weekly on
  Saturday. An urgent fix for game night may ship sooner. Never deploy on a
  Tuesday or Thursday evening (game nights).
- **Bump `CACHE_NAME` in `public/sw.js` on every hosting deploy** that
  changes a page or JS, and run `node scripts/sw-check.js` first. A bump
  reloads open pages that load `update-check.js`; `checkin.html`,
  `tonight.html` and `director.html` do not, so kiosks pick up a new build
  when they are reloaded at setup (the owner's choice, 2026-10-14).
  The install list must not repeat a URL (`cache.addAll` rejects a
  duplicate, and `sw-check.js` checks for one). Since 2026-10-14 (v90) the
  worker caches only the site's own files (other origins,
  `/api/` and `/__/` go straight to the network) and on activate deletes
  only old `all-in-poker-*` caches, because Cache Storage is shared with the
  venue timer's own worker `staff/timer-sw.js` (scope `/staff/timer`).
  Tests and rollback: `docs/sw-reenable-test-2026-10-14.md`.
- Pages import `./firebase-api.js?v=N`. A page that also imports
  `staff-auth.js` must use the same `?v=` as that file (`?v=6`) or Firebase
  initializes twice.
- Removing a function from index.js does not remove it from prod;
  `firebase functions:delete <name>` does.

## Claude commands (in `.claude/commands/`)

`/audit-scores`, `/season-health`, `/enter-scoresheet` (photo of the paper
sheet → finalized game, drives director.html), `/player-sweep`.

## Running the commands in this copy

This copy has no live project. The scripts behind the commands run against
the Firestore emulator loaded with the generated club:

```bash
firebase emulators:start --only firestore,auth --project demo-poker
# in a second shell
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
node demo/seed.js --load
cd functions && node scripts/player-sweep.js --text
node scripts/game-state.js "8/27/2026" "Wild Corgi" 2 --verify
cd .. && python scripts/season_health.py
```

Steps that drive a page in the browser (`/enter-scoresheet`, `/audit-scores`)
need the pages pointed at the emulators first; see Limits in README.md.

## Ops facts worth knowing

- Cloud Logging retention is 30 days. Function usage over a month
  (2026-08): getLiveScoring and getDailyStats dominate (30 s polling from
  director/dashboard/tonight), then getLeaderboard, getSchedule, checkin.
- `gamedayAnnouncement` cron runs 10:00 America/Denver daily;
  `unfinalizedGameSweep` daily.
- `getPlayerList`, `getHighHands`, `getHallOfFame`, `getAnnouncements` are
  direct Firestore reads in firebase-api.js, not callables.
- Season boot: `admin/seasons.html` is the only working creator. A season
  without `endDate` makes standings silently show the previous season.
- Keep commits scoped. This copy's history starts at publication; the
  private repository holds the full history.

## Open work (2026-09-05)

Admin Game Record page to replace game-inspector ·
collapse the three event editors · retire dashboard.html · hoist points
table and top-20 ranking into firebase-api.js · synced clock step 4 (live night) and
going live with the phone pages (see docs/timer-prd/07-synced-clock.md) ·
210 never-seen roster rows (200 GAS imports) if a purge is wanted.
(Firestore rules, timer state persistence and the app-wide service worker are in place; updated 2026-10-14.)
