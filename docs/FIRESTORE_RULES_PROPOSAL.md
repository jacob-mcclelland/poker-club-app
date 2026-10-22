# Firestore rules — deployed 2026-09-05

> **STATUS: LIVE.** Deployed 2026-09-05 after 47/47 synthetic test cases passed
> against the Rules API and a signed-out verification pass against production.
> This document is kept as the rationale and the access matrix. Rollback copy of
> the previous wildcard ruleset is in the repo history of this file, and in the
> Firebase console's Rules history.

## What was live before this change

Pulled from the Firebase Rules API (release `cloud.firestore`, ruleset created
2026-02-02):

```
match /{document=**} {
  allow read, write: if request.time < timestamp.date(2030, 2, 4);
}
```

Every document is readable and writable by anyone holding the public web API
key, which is in every page's source. That includes:

- `userProfiles/*.role` — any signed-in player can set themselves to `admin`
  from the browser console and then pass every `requireRole` gate.
- `checkins`, `eliminations`, `bounties` — standings can be edited by anyone.
- `seasons`, `schedule`, `config/champions` — season definitions.

The callable functions' `requireRole` checks are real, but they only protect
the callable path. Every direct Firestore write from a page bypasses them.

## The ruleset

`firestore.rules` at the app root, wired in via the `firestore` key in
`firebase.json`. Summary:

| Collection | Read | Client write | Why |
|---|---|---|---|
| players, checkins, eliminations, bounties | public | admin only | player app and kiosk read without login; `season_health.py` reads with the API key; game-inspector (admin) still writes directly |
| rsvps, seasons, schedule, eventContent, announcements, champ_overrides | public | none | all writes go through callables |
| config/* | public | admin | seasons.html writes `config/champions` directly |
| userProfiles | get: own doc or admin; list: admin only | own doc, non-role fields; admin any | index.html / gameday.html write preferences and linkedName; players.html (admin) lists and writes roles |
| shotRounds, shotOptions | public | open (shotOptions delete: admin) | shots.html and bar.html run without login today — **accepted risk** |
| mail | admin | admin create | comms.html enqueues for the send-email extension |
| emailList, clientErrors, submissionAudits, qualifiers, scoringEvents | none | none | server-only |
| everything else | none | none | default deny |

## Access matrix this was derived from

Direct browser access found in `public/` on 2026-09-05 (callable calls excluded):

| Page | Reads | Writes |
|---|---|---|
| firebase-api.js | players, announcements, seasons, config/highHands, config/champions; listeners on checkins, rsvps, bounties, eliminations | none |
| index.html | userProfiles (own) | userProfiles (own: preferences, preferredEmail, linkedName) |
| gameday.html | userProfiles (own) | userProfiles (own: linkedName) |
| staff-auth.js, admin-auth.js, admin/index.html | userProfiles (own) | none |
| tonight.html | shotRounds | none |
| new-players.html | checkins, rsvps (full scan) | none |
| championship-director.html, staff/timer.html | checkins, rsvps, bounties | none |
| shots.html | shotRounds, shotOptions, userProfiles (own) | shotRounds (create/update/delete own card), shotOptions (upsert) |
| bar.html | shotRounds (today) | shotRounds (poured/paid patch) |
| admin/players.html | userProfiles (all) | userProfiles (role, isAdmin, isStaff, preferences) |
| admin/seasons.html | — | config/champions |
| admin/shot-log.html | shotRounds | none |
| admin/comms.html | schedule | mail (create) |
| admin/game-inspector.html | checkins, eliminations, bounties, players | checkins, eliminations, bounties (add/update/delete) |

## Two accepted risks

1. **Shot rounds stay open.** shots.html is used by players who may not be
   signed in, and bar.html runs on a tablet with no login. Locking these
   would break drink orders on a game night. The exposure is someone forging
   or editing a drink order, which is visible to the bartender in real time.
   Fix later by requiring sign-in on shots.html and giving the bar tablet a
   staff session.
2. **Admins can still write game rows directly** because game-inspector does.
   That is admin-only, so it is the callable gate's trust level, not worse.
   Goes away with the admin Game Record page.

## What it closes immediately

- Role self-promotion (the `ownProfileKeysOnly` check).
- Anonymous or player-level edits to check-ins, placements, bounties,
  seasons, schedule, champions.
- Reads of `emailList` (subscriber emails) and `userProfiles` by
  unauthenticated clients.

## Re-testing after any rules change

```bash
node scripts/rules-test.js     # 47 cases against the Rules API, deploys nothing
```

Note: `functions/scripts/season_health.py` reads Firestore over REST with the
web API key and no auth. It keeps working because game
collections stay publicly readable (verified after deploy).


## Deployment record — 2026-09-05

**Tested before deploy.** 47 synthetic cases run through the Firebase Rules API
`projects:test` endpoint (no emulator; Java is not installed on this machine).
The suite lives at the scratchpad path recorded in the commit and covers every
row of the matrix above plus the escalation cases.

Two bugs were caught by that suite and fixed before anything shipped:

1. **`uid` was missing from the own-profile allowlist.** index.html writes
   `uid` when a player claims their name, so claiming would have failed with a
   permission error for every new player.
2. **Bare property reads on profile fields throw.** `profile().role` errors when
   a document has no `role` field, and reading a missing field is an error in
   rules rather than a null. An admin whose profile carried only `isAdmin` and
   no `role` would have been locked out of every admin write. Both helpers now
   use `map.get(key, default)`.

A third improvement came out of the review: `userProfiles` read was split into
`get` (own doc, or any doc for admins) and `list` (admins only). Previously any
signed-in player could enumerate the whole collection, which holds every
member's email address.

**Verified after deploy**, unauthenticated against production REST:

| Check | Result |
|---|---|
| Reads: checkins, bounties, schedule, seasons, players, eliminations, rsvps, announcements, eventContent, config | 200 — all still public |
| Reads: userProfiles, emailList, clientErrors, submissionAudits, scoringEvents, qualifiers, mail | 403 — all closed |
| Writes: checkins, eliminations, bounties, rsvps, players, seasons, schedule, announcements, userProfiles | 403 — tampering closed |
| Write: shotRounds | 200 — drink orders still work (probe doc created and deleted) |
| Callable `getSchedule` | 200 — Admin SDK unaffected |
| Player app signed out: RSVP tab, Standings tab, home.html, bar.html, shots.html | load with zero console errors |

**Signed-in verification, same day**, driven through the owner's own Chrome session
(their existing login; no credentials were entered):

| Page | Result |
|---|---|
| index.html | Admin/Staff Portal buttons render, no errors |
| gameday.html (staff hub) | clean |
| director.html | clean, schedule dropdown and player search populated |
| dashboard.html | clean, passes the same `requireStaff` gate |
| tonight.html | clean, 9/3 Wild Corgi shows 35 and 30 checked in with full name lists |
| admin/players.html | **lists all 24 profiles with emails and role badges** — the admin-only `list` rule working |
| admin/seasons.html | clean |
| admin/shot-log.html | clean, 12 rounds / 80 shots / 39 served over 7 days |
| admin/game-inspector.html | clean, all 37 game dates load |

All privileged accounts were checked against the new helper semantics before
this pass: 2 admins (the owner, Robb) carry `role: 'admin'` and `isAdmin: true`, and all
8 staff carry `role: 'staff'`. Nobody is locked out by the field-shape bug the
test suite caught.

Not exercised, because doing so would mutate production: the admin *write*
paths (saving a role in players.html, saving title holders in seasons.html,
editing a roster in game-inspector). Those are covered by synthetic cases in
`scripts/rules-test.js` with a mocked admin profile, and the real profiles are
confirmed to match that mock.

**One pre-existing wrinkle, not caused by the rules:** the very first staff page
load in a cold browser hit `Timed out restoring sign-in session` from the 5s
timeout in `staff-auth.js`. It resolved on the next load and did not recur on
any page. The timeout fires before any Firestore call, so it is a Firebase Auth
cold-start, not a permission problem. Worth raising that 5s ceiling.

**Unrelated pre-existing bug found during verification:**
`scripts/season_health.py` crashes with a `TypeError` when the active season has
an empty `championshipDate`. Season 29 (Tight End, started 7/28/2026) has one.
The Firestore reads it performs all succeed under the new rules; this is a data
gap plus a missing None guard, and the script has not been touched since May.

## Rollback

```bash
cd "…/All-In-Poker-App"
# restore the previous wildcard, then:
firebase deploy --only firestore:rules
```
Or use Rules history in the Firebase console, which keeps every released
ruleset. The pre-change wildcard was released 2026-02-02.
