# App-wide service worker: re-enable test (2026-10-14)

`public/sw.js` had not installed in Chrome since about May 2026:
`/announcements.html` was listed in both `APP_SHELL_FALLBACKS` and
`STATIC_ASSETS`, `cache.addAll` rejects a list with a repeated URL, and the
worker went installing -> redundant. No page was controlled by it, and
CACHE_NAME bumps did nothing.

**Fix (branch `sw-dedupe`):** the duplicate is removed from `STATIC_ASSETS`,
the install list goes through a `Set` so a repeat cannot break install again,
and, after the first test below, the worker leaves other sites' requests alone
(see "Retest after the owner's decision"). `CACHE_NAME` is `all-in-poker-v90`.
`node scripts/sw-check.js` checks the install list and the routing.

**Deployed live on 2026-10-14 at 13:54 MDT** with the owner's OK (see "Live deploy"
at the end). The tests before that ran on a preview channel: the first with
the fetch handlers unchanged (v89), the retest with the bypass (v90).

## How it was tested

- Preview: https://preview.poker-club.example (expires
  2026-10-21). Deployed from a clean export of the committed tree plus the new
  `sw.js`, so other sessions' uncommitted page edits are not in it. The
  channel domain was added to Auth's authorized domains by the CLI, so staff
  sign-in works there.
- the owner's Chrome through the Claude in Chrome extension, 12:42 to 13:06 MDT.
  The two bump tests used v90 and v91 builds deployed only to the channel;
  the channel was then reset to exactly the committed content (v89). Live
  hosting still serves v88 with the duplicate.
- No Firestore writes and no check-ins. Staff pages were opened signed out.

## Results

| Check | Result |
|---|---|
| Install | Works. installing -> activated, cache `all-in-poker-v89` holds the 20 install URLs, no install error. |
| First visit | The page reloads itself once, about 1 to 2 s in: `clients.claim()` fires `controllerchange` and `update-check.js` reloads. Every player sees this once after a live deploy. |
| `index.html` | Controlled. `getSchedule` and `getWinners` callables returned; schedule and announcements rendered. |
| `checkin.html` (via `/staff/checkin.html`) | Controlled. `getSchedule` and the Firestore player list loaded. |
| `director.html` (via `/staff/director.html`) | Controlled. `getSchedule`, `getDailyStats`, `getLiveScoring` and its Firestore listener loaded (signed out). |
| `tonight.html` | Controlled. Stops at the staff sign-in gate; not signed in, so its data path is untested. |
| `/contest/photos` | Controlled. Firestore listeners loaded; no club contest today, so no photo wall. |
| Callables | Unaffected. They are POSTs and the worker ignores non-GET requests. |
| Firestore realtime | Works. With one listener open, a second listener got its server snapshot in 310 ms and no Listen GET completed in between, so pushed data streams through the worker over the open connection. |
| CACHE_NAME bump, on navigation (v89 -> v90) | New worker installed and activated, the v89 cache was deleted, and the open index tab reloaded onto the new HTML. |
| CACHE_NAME bump, next page load (v90 -> v91) | Picked up on the next load of a page with `update-check.js` (it calls `reg.update()` on load); the v90 cache was deleted. |
| CACHE_NAME bump, unattended 5-minute poll | **Not observed.** Chrome froze the background test tabs (the machine had about 570 MB of RAM free), so their timers never ran. Phones freeze background tabs too, so in practice phones update on their next open; only a page left in front, like a kiosk, relies on the poll. A fresh tab confirmed the worker itself was not hung. |
| Kiosk and staff pages on a bump | **Do not reload.** `checkin.html` stayed on the old build after both bumps. It, `tonight.html` and `director.html` do not load `update-check.js`, so the "kiosk tablets pick up new builds through the bump" step in CLAUDE.md does not reach them. |

## Cross-origin requests through the generic handler (first test, v89)

The last handler in `sw.js` sends every other GET to the network and writes
the response into Cache Storage, cross-origin included.

- **Firestore.** Every `Listen/channel` streaming GET is written to the
  cache when it ends: about 370 KB per index load (the initial query data).
  Cache Storage reached about 9 MB after six page loads.
- **No stale Firestore data.** Each of those URLs carries a fresh
  `gsessionid`, `SID`, `AID`, `zx` and `t`, so `caches.match` never matches a
  later request. Offline they fall through to a network error, as they do with
  no worker. They are dead weight until the next CACHE_NAME bump deletes the
  cache.
- **Firebase Storage images.** An event image from
  `firebasestorage.googleapis.com` loaded by `<img>` was cached as an opaque
  response (status 0), and Chrome counted about 16 MB of quota for it
  (Chrome pads opaque entries). Each distinct Storage image a phone shows adds
  that. Served only offline, and the URL carries its token, so not stale.
- Also cached: the versioned Firebase SDK files from `www.gstatic.com` and
  Google Fonts. Harmless.
- Why the size matters: under storage pressure Chrome evicts an origin's
  storage all at once, which would include Firebase Auth's IndexedDB and sign
  staff out. Not observed here; it is the reason to keep the cache small.

## Retest after the owner's decision (v90)

The owner decided on 2026-10-14: the worker caches only the site's own pages, scripts
and images. Firestore, Cloud Functions, Google sign-in and Firebase Storage go
straight to the network; offline photos can be a separate decision later. The
fetch listener now returns without `respondWith` for any other origin, and for
same-origin `/api/` (the Cloud Function rewrite) and `/__/` (Firebase's
reserved sign-in URLs).

Retested on the same preview in the owner's Chrome, 13:20 to 13:25 MDT:

| Check | Result |
|---|---|
| Update from the previous preview build | v90 installed, the page reloaded once, and the older cache was deleted. |
| Firestore realtime | Works: a listener got server data in 140 ms, and a second one added 8 s later also in 140 ms. |
| Callables | `getSchedule` returned 5 events; director's `getSchedule` and `getDailyStats` loaded. |
| Firebase Storage image | Loads (1536 px wide) and is not cached; Cache Storage grew by 0 KB. |
| `checkin.html`, `director.html`, `/contest/photos` | Controlled and loading as before. |
| Cache contents after index, checkin, director and contest | 40 entries, all from the site itself, none under `/api/` or `/__/`, about 2.1 MB in total. Before the change: about 9 MB after six loads, plus about 16 MB per Storage image. |
| `node scripts/sw-check.js` | All checks pass on v90. Against the May-to-October `sw.js` it exits 1. |

## Release review (independent, before shipping)

A cross-family review (gpt-6-astra) of the v90 release found one blocker,
now fixed:

- **Activation deleted the venue timer's offline cache.** Cache Storage is
  shared by every worker on the site, and `sw.js` deleted every cache except
  its own, including `venue-timer-offline-v1` from `staff/timer-sw.js`. Any
  device that opens a page registering `sw.js` (index, gameday hub, bar,
  shots, new-players) would lose the timer's offline copy at first install
  and again at every bump. `sw.js` now deletes only old `all-in-poker-*`
  caches. `scripts/sw-check.js` checks activation with a timer cache present;
  that check fails on the unfixed worker.

Notes the review raised, all behaviour that predates this change and is left
as it is for now:

- Offline, a page URL that was never cached falls back to the cached `/`, so
  a player can see the home page under another page's address.
- Cache writes do not check the response status and network-first requests
  have no timeout, so a 404/500 can replace a cached copy and a hanging
  connection delays the offline fallback.
- A same-origin request that redirects to another origin could still be
  cached. No such redirect exists in the app today.

## Rollback

Restoring the old `sw.js` does not undo this: its duplicate install list
fails to install, so devices keep v90. To roll back, deploy a byte-changed
`sw.js` that installs, deletes only `all-in-poker-*` caches, calls
`clients.claim()`, and has no fetch listener. Pages then load straight from
the network as they did before.

## Decisions for the owner

1. **Cross-origin caching:** decided, see above.
2. **Live deploy timing.** The first-visit reload hits every open player page
   once, so deploy outside a Tuesday or Thursday game night.
3. **Kiosk updates.** The owner decided on 2026-10-14 not to add `update-check.js` to
   `checkin.html` and `tonight.html` for now; kiosks are refreshed at setup
   each night.

## Smaller notes

- On a device that has never opened the venue timer, the first
  `/staff/timer*.html` load is controlled by `sw.js` until
  `staff/timer-sw.js` registers 5 s later; later loads use the timer worker.
  Since v90 that first load's `/api/server-time` calls bypass `sw.js`
  entirely. The timer worker and pages were not changed or opened.
- The HTML handler caches every navigation response, query-string variants
  included. Cleared on each bump; not a problem seen in testing.

## Live deploy (2026-10-14, 13:54 MDT)

The owner approved shipping on Wednesday 2026-10-14 (no game that night).

- Deployed with `firebase deploy --only hosting` from a clean worktree of
  `firebase-cloud-functions` at 2b68e3a5, checked out without CRLF
  conversion. Twenty public files that live served with CRLF line endings
  (git stores LF) were set to the live bytes first, so the deploy changed
  nothing but `sw.js`. Before the deploy, a SHA-256 comparison of all 131
  public files against the live site showed only `sw.js` differing; after
  it, 131 of 131 matched.
- Live `sw.js` is `all-in-poker-v90` with the same-origin rule and the
  `all-in-poker-*` cleanup rule. `/api/server-time` returns JSON.
- In the owner's Chrome on the live site (no worker or cache there before): opening
  `/staff/timer.html` registered `staff/timer-sw.js` (scope `/staff/timer`)
  with 13 files in `venue-timer-offline-v1`. Opening `/` then installed and
  activated `sw.js` v90; the page reloaded once and rendered the schedule.
  Afterwards both workers were active, the timer cache still held its 13
  files, the app cache held 24 same-origin files, and reopening the timer
  page showed it controlled by `/staff/timer-sw.js`.
- Not pushed to GitHub.
