# 07 - Synced Clock: Shared Timer, Phone Viewer, Phone Controller

Status: **Approved by J 2026-10-14.** Step 1 (TV) live 2026-10-14. Steps 2 and 3 (controller, player view) built and tested on the preview channel 2026-10-14; not live yet.
This extends the March PRD, which listed "remote timer control" and "real-time
sync across displays" as future work (01-overview.md, Out of Scope).

---

## Part 1: The plan in plain language

### What we're building

1. **A shared clock.** The tournament clock moves out of the TV laptop's
   memory and into the app's database. The TV, your phone, and every
   player's phone all read the same clock.
2. **A phone viewer for players.** Scan a QR code at the table and get a
   big, simple clock: game name, time, blinds. Optional sound, optional
   keep-screen-on.
3. **A phone controller for staff.** Sign in and get the TV's buttons on
   your phone: play/pause, +1/-1 minute, next/previous level, reset. Plus
   Hand of the Night and TV layout from the phone.
4. **A fallback that always works.** If the internet goes down, the TV keeps
   running in the browser exactly like today. See Part 3b.

### What stays the same

- **The TV page looks and works exactly like it does today.** Same layout,
  same buttons, same keyboard shortcuts, same chime. Only the plumbing behind
  the clock changes.
- Rounds still roll straight into the next level. Breaks still stop at the
  end and wait for you to press start.
- The Bomb Pot and Pocket Queenz timers are untouched for now.

### Why this also fixes two existing problems

- **Refreshing the TV laptop no longer resets the clock.** Today the clock
  only exists in that browser tab. (This is on the app's open-work list as
  "timer state persistence".)
- **The clock stops drifting.** Today it subtracts one second at a time, so
  it can run slow when the laptop is busy. The new clock is worked out from
  the real time, so it can't drift.

### How the sync works (the one idea that matters)

The clock itself is never sent between devices. The database only stores a
few facts per game:

- which level we're on,
- running or paused,
- how much time was left, and the exact moment that was true.

Every screen does its own countdown from those facts. When you press pause,
one small update goes out and every screen freezes, usually within a second.
A phone that hears about it late doesn't fall behind: it does the math and
lands on the same time as the TV.

Level changes don't need anyone to press anything. Every device knows the
blind structure, so they all roll to the next level at the same moment on
their own.

---

## Part 2: The phone viewer (players)

**Link:** one QR code per venue, printed once and reused every week
(`/clock?venue=tight`, `/clock?venue=corgi`). No sign-in.

### What's on the screen

Only what's needed, so it reads from across a table:

| Element | Size | Notes |
|---|---|---|
| Game name | small, top | "Game 1" / "Game 2" |
| Clock | as large as the screen allows | the most prominent thing |
| Blinds (and ante, if the structure has one) | second largest, under the clock | During breaks: the break name ("Break & Chip Up"). Before the game: "Draw for Seats" / "Announcements". Late levels show the same short form as the TV ("1 / 2", 5K chips). |
| Game toggle | small switch | Only appears when Game 2 is in play |
| Sound and keep-awake buttons | small icons, corner | Show on/off state |

Not shown: next level, time to break, scores, standings, bounties.

- **Landscape first** (phone on its side or on a stand), with a portrait
  layout that also works.
- **Game toggle:** appears once Game 2 has been started tonight. One game
  shows at a time. The phone remembers which game the player picked.
- **Paused mid-level:** the clock freezes and "PAUSED" shows in large
  letters. No sound.
- **No game running** (for example, a QR scanned on a Wednesday): shows
  "No clock running right now".
- **Connection lost:** the clock keeps counting from what it last knew. A
  small dot shows it is reconnecting. When it reconnects, it catches up to
  any pause or change it missed.

### Dim and bright

A web page can't change the phone's brightness setting. "Dim" means the
page itself goes dark: black background, muted numbers. That saves battery,
especially on phones with OLED screens.

| Moment | Screen |
|---|---|
| Normal play | dim |
| Final minute of a level | bright |
| New level starts | bright for about 10 seconds so people see the new blinds, then dim |
| Break starts | bright for about 10 seconds, then dim |
| Final minute of a break | bright |
| Break over, waiting for you to press start | bright, shows "Take your seats" |
| You press start | dims after about 10 seconds |

### Keep screen on

- Tapping the keep-awake icon tells the phone not to sleep while the page
  is open (Screen Wake Lock: iPhone iOS 16.4+, Android Chrome).
- If the player switches apps and comes back, the page turns it back on
  automatically.
- Older phones get a fallback that does the same job.
- A phone that has already locked can't be woken by a web page. That's why
  keep-awake matters: it keeps the screen on, and the page switches between
  dim and bright.

### Sounds

Off until the player taps the sound icon (phones require a tap before a
page can make noise). Each moment has its own named sound slot, so beeps can
be swapped for other sounds or spoken voice later without touching the
logic.

| Moment | Sound slot | First version |
|---|---|---|
| Level: 1:00 left | `levelWarning` | soft short chime |
| Level ends, next level starts | `levelChange` | two-tone chime |
| Level ends, break starts | `breakStart` | louder, longer pattern |
| Break: 2:00 left | `breakTwoMin` | beep |
| Break: 1:00 left | `breakOneMin` | beep (different pitch) |
| Break reaches 0:00 | none | you're coordinating dealers at this point |
| You press start after a break | `cardsInAir` | distinct "we're live" sound |
| Mid-level pause or resume | none | screen shows PAUSED |

- All phones work from the same corrected clock, so countdown sounds should
  land within a fraction of a second of each other. Expect a quick ripple
  across the room, not one perfectly unified beep.
- The "we're live" sound plays when each phone hears that you pressed start,
  so it can arrive a second or two apart. The clocks themselves still match.
- A phone that opens the page late, or comes back from another app, does
  not play a burst of sounds it missed. Sounds only play for moments that
  just happened.
- The TV keeps its current chime. Its sound is unchanged.

---

## Part 3: The phone controller (staff)

**Link:** `/staff/clock-control.html?venue=tight`, behind the normal staff
sign-in. Any account with the staff or admin role can control the clock.

### Screen

- Game 1 / Game 2 tabs.
- The same clock and blinds the players see, so you know what they see.
- **Play / Pause:** one large button.
- **+1 min / -1 min.**
- **Previous / Next level.**
- **Reset:** asks "Reset Game 1 for everyone?" before doing it, because it
  changes every screen in the room.
- **Sync status:** "Live" when connected, "Sending..." when a press hasn't
  reached the database yet, "Offline" when there's no connection.

### TV extras

A second tab on the controller for things you'd otherwise walk to the laptop
for:

- **Hand of the Night:** edit theme, hand, and bonus, or clear it. Uses the
  same save and clear the TV uses today, so it's already staff-only. The TV
  picks up the change within a second or two (today it only updates when the
  TV is refreshed).
- **TV layout:** the same presets as the TV menu (Timer 1, Timer 2, Scores
  Only, Full 1, Full 2, Dual Timer). Picking one switches the TV.
- **Refresh TV data:** same as the TV's Refresh link (standings, bounties,
  Hand of the Night).

The TV's local menu keeps working as it does now.

### How control behaves

- The TV laptop's buttons and keyboard keep working. The phone controller
  is an extra remote, not a replacement.
- If two devices press buttons at the same moment, the last press wins.
  Every press saves the whole game state, so the clock is never left
  half-changed.
- If your phone loses signal, the clock keeps running everywhere else. A
  press made while offline shows "Sending..." and goes through when you
  reconnect.
- If the TV laptop loses Wi-Fi (like 9/29), the TV keeps running its own
  clock and its buttons still work on the TV. Phones on cellular keep
  running from the last update. When Wi-Fi comes back, the TV's presses
  catch up.

---

## Part 3b: Fallback when everything goes down

**The TV must always work like it does today, with or without internet.**
The shared clock is an add-on to the TV, never something the TV depends on.

### Three layers of protection

1. **The TV runs its own clock first.** The TV's clock and buttons work in
   the browser by themselves. The sharing part loads separately on top. If
   the internet drops, or the database can't be reached at all, the TV just
   keeps going as a normal standalone timer. Nothing to press.
2. **A "Local only" switch on the TV menu.** One click cuts the TV off from
   the shared clock: it stops listening to phones and stops sending updates,
   and runs exactly like today's timer from wherever the clock is. Use it if
   anything about the sync seems off. The menu shows **Shared** or
   **Local** so you always know which mode it's in.
3. **The current timer stays available as-is.** Today's page is kept as an
   untouched copy (`staff/timer-classic.html`), bookmarked on the laptop, for
   at least the first several weeks. If the new version ever misbehaves, open
   the classic one and run the night the old way.

### Refresh with no internet

The TV saves the clock to the laptop itself on every change. If the page is
refreshed during an outage, it comes back at the right level and time
(and, if it was running, with the time that passed while it reloaded).

Also: today, refreshing the timer with no internet may give a blank page,
because some of the page's code is downloaded fresh each time. The build
will make the timer page reopen offline, and testing will confirm it.

### Coming back online

- **Automatic case** (signal dropped, TV stayed in Shared): when the
  connection returns, the TV's presses go through and phones catch up.
- **After using Local only:** switching back to **Shared** makes the TV's
  clock the truth. The TV pushes its level and time to the database and every
  phone snaps to match. Whatever the TV shows wins, because it's the one
  you've been running the room from.

---

## Part 4: Technical design (for the implementer)

### Files

| File | Change |
|---|---|
| `public/clock-engine.js` (new) | Pure clock math (`clockAt`), no Firebase imports, so it runs with no network |
| `public/clock-sync.js` (new) | Firestore read/write, server-time offset, sound slots. Loaded with a dynamic `import()` so a failure leaves the TV in local mode |
| `public/staff/timer.html` | Replace `Timer` internals (line 1330) with the engine. Keep all markup, layout, buttons, keys, and `playLevelEndSound`. Add the Shared/Local menu switch, the localStorage mirror, and live Hand of the Night and TV-command listeners |
| `public/staff/timer-classic.html` (new) | Byte-for-byte copy of today's `timer.html`, taken before any edit. Not modified afterwards |
| `public/clock.html` (new) | Player viewer |
| `public/staff/clock-control.html` (new) | Staff controller, gated with `requireStaff()` |
| `functions/index.js` | New ungated HTTPS function `serverTime` returning `Date.now()` |
| `firebase.json` | `/clock` rewrite ahead of `**` (like `/contest*`) |
| `public/staff/timer-sw.js` (new) | The timer's own offline worker, scope `/staff/timer`: caches every file the timer loaded so the page reopens offline. (Revised 2026-10-14: the first build put this in the app-wide `public/sw.js`, whose install has failed in Chrome since about May 2026 because of a duplicate entry; `sw.js` is back to its previous content plus the `CACHE_NAME` bump.) |
| `firestore.rules` (proposal only) | Add `timerClocks`: read for anyone, write for staff. Not deployed with this work |
| `CLAUDE.md` | Add the new pages to "Pages by audience" |

### Firestore document

One document per venue: `timerClocks/{venue}` (`tight`, `corgi`).

```js
{
  venue: 'tight',
  structure: { id: 'standard', levels: [ /* copy of BLIND_LEVELS */ ] },
  games: {
    '1': {
      levelIndex: 2,
      status: 'running' | 'paused',
      remainingMs: 720000,   // time left at anchorAt
      anchorAt: 1760480000000, // server-time ms when remainingMs was true
      changedAt: 1760480000000, // server-time ms of the press that made this state
      startedTonight: true   // false after reset; Game 2 toggle keys off it
    },
    '2': { ... }
  },
  tv: {
    layout: 'dual',      // last preset requested from the controller
    layoutSeq: 7,        // bumped per request; TV applies when it changes
    refreshSeq: 3        // bumped per "Refresh TV data" request
  },
  updatedAt: <server timestamp>,
  updatedBy: { uid, name, device: 'tv' | 'phone' }
}
```

- The **structure travels in the document.** The TV writes `BLIND_LEVELS`
  into it on reset. The viewer and controller never hardcode a structure,
  so the Bomb Pot and Pocket Queenz timers can join later by publishing
  their own.
- `anchorAt` and `changedAt` are plain numbers in **server time**: the
  writer's `Date.now()` plus its measured server offset (below). They are
  not `serverTimestamp()`, because a write anchored on arrival would lose the
  network delay on every press, and an offline TV could not compute its own
  state. (Revised 2026-10-14 during build; replaces the earlier
  `serverTimestamp()` anchor.) `updatedAt` stays a `serverTimestamp()` for
  staleness checks.
- Writes replace the whole game object (no increments), so every write is a
  coherent state.
- **Newest press wins, per game:** a device adopts a game from the database
  only if its `changedAt` is at least the local one. If the local state is
  newer (for example, presses made on the TV while offline, then a reload),
  the device writes its state back up instead.

### The clock function

One pure function in `clock-engine.js`, used by every screen:

```
clockAt(gameState, levels, serverNowMs) -> { levelIndex, remainingMs, phase }
phase: 'running' | 'paused' | 'holding' | 'idle' | 'finished'
```

- Paused: return the stored level and `remainingMs`.
- Running: `elapsed = serverNow - anchorAt`. While `elapsed` exceeds the
  current level's remaining time, walk forward:
  - a round or pre-game level rolls into the next level at full duration
    (matches `advanceRound`);
  - a break moves to the next level at full duration and stops there:
    `phase: 'holding'` (matches `nextRound` after a break: the TV shows the
    next level, paused, at full time);
  - the last level ends at 0:00: `phase: 'finished'`.
- **Every control press first calls `clockAt` to get the true current
  state, then writes that state with the change applied.** Example: pressing
  Start during `holding` writes `{ levelIndex: next, status: 'running',
  remainingMs: fullDuration, anchorAt: now, changedAt: now }`.

Because rollovers are computed, nobody has to be online for a level to
change, and every device changes level at the same moment.

### Server time

Each device needs to know the server's current time to within a few hundred
milliseconds.

- On load, call `serverTime` 3 to 5 times. Keep the sample with the shortest
  round trip: `offset = serverMs + roundTrip / 2 - localMs`. Repeat every 10
  minutes and on reconnect.
- If the function can't be reached, fall back to the `Date` header of a
  no-cache hosting request, then to the device clock.
- The first call may hit a cold start. Using the fastest sample handles it.
- Alternative: Realtime Database `.info/serverTimeOffset` gives the same
  number with no function, but requires enabling a second Firebase database
  in the project. The function is the smaller change.

### TV page (`timer.html`)

Local-first. The TV owns a local copy of the game state at all times;
Firestore is a mirror it reads from and writes to when available.

- Local state is the same shape as `games` in the Firestore document,
  anchored on the TV's own corrected clock. `Timer.games[id]` is that state
  run through `clockAt`. `tick()` only redraws. It no longer subtracts.
- Every change writes local state to `localStorage`
  (`timerClock_${venue}`). On load the TV restores it first, then attaches
  to Firestore if it can.
- `clock-sync.js` is loaded with `import()` inside try/catch. If it, or the
  Firebase SDK, fails to load, the TV stays in local mode and shows
  **Local** in the menu.
- **Shared mode:** Firestore snapshots replace local state when their
  `changedAt` is at least the local one. Local presses update local state at
  once and write to Firestore.
- **Local mode** (menu switch, remembered in `localStorage`): the
  listener is detached and writes stop. The clock keeps running from local
  state.
- **Local to Shared:** write the TV's current `clockAt` result for both
  games to Firestore as a fresh anchor, then reattach the listener.
- Hand of the Night: replace the load-on-refresh with an `onSnapshot` on
  `config/handOfNight` (direct read, as `getHandOfNight` already reads it).
  Saving still goes through the `saveHandOfNight` / `clearHandOfNight`
  callables.
- TV commands: when `tv.layoutSeq` or `tv.refreshSeq` increases, call
  `applyLayout(tv.layout)` or `refreshData()`. Ignore the values present at
  page load so a reload doesn't replay an old command.
- `start`, `pause`, `addMinute`, `subtractMinute`, `nextRound`, `prevRound`,
  `reset` write to Firestore **and apply locally at once**, so the TV
  responds instantly and keeps working with no network (Firestore queues
  the write offline).
- `playLevelEndSound` fires on the computed 0:00 boundary as it does today.
- Display functions (`updateTimerDisplay`, `updateBlindsDisplay`, layouts,
  panel system) do not change.
- The page stays ungated, as today. When the Firestore rules proposal is
  deployed, the laptop will need one staff sign-in.

### Viewer page (`clock.html`)

- Read-only `onSnapshot` on `timerClocks/{venue}`. Redraws with
  `requestAnimationFrame`, capped to about 4 times a second.
- Shows "No clock running" when `updatedAt` is more than 12 hours old and no
  game is running.
- Sounds: Web Audio tones generated in code (no files), one shared
  `AudioContext` (the TV hit Chrome's six-context limit before; see the
  comment at timer.html:2811), unlocked on the sound tap. A sound plays only
  if its moment happened in the last 3 seconds. On iPhone, set
  `navigator.audioSession.type = 'playback'` where supported so the silent
  switch doesn't mute it; confirm in testing.
- Wake lock: `navigator.wakeLock.request('screen')` on tap, re-request on
  `visibilitychange`. Fallback for older phones: a muted, looping, inline
  video bundled with the page (no third-party script).
- Remembers the chosen game and the sound and keep-awake toggles in
  `localStorage`, wrapped in try/catch.

### Controller page (`staff/clock-control.html`)

- `requireStaff()` gate, `firebase-api.js?v=6` to match `staff-auth.js`.
- Same engine and snapshot as the viewer, plus the write calls.
- TV extras tab: Hand of the Night form calling `PokerAPI.saveHandOfNight` /
  `clearHandOfNight` (venue mapped through `apiVenue`, as the TV does);
  layout buttons and Refresh bump `tv.layoutSeq` / `tv.refreshSeq`.
- Sync status from snapshot metadata: `hasPendingWrites` shows
  "Sending...", `fromCache` with no server snapshot for 10 seconds shows
  "Offline".

### Security note

Corrected 2026-10-14 during build: Firestore rules have been deployed and
enforced since 2026-09-05 (the "allow-all" note in CLAUDE.md was out of
date), so `timerClocks` was refused until it got a rule. `firestore.rules`
now has one: read for anyone, create/update for staff (same test as
`requireStaff()`), only the known top-level fields, delete for admins.

Consequence for the TV: it must be signed in as staff to send changes. A TV
that isn't keeps running locally, and its menu shows **Shared · sign in**;
clicking it opens the staff sign-in and then sends the TV's clock up. The
TV already asked for this sign-in to save Hand of the Night, so most
laptops are signed in already.

Also changed in build: `clock-sync.js` has no imports (the page passes in
its Firebase module), so the TV imports it statically like the engine;
only `firebase-api.js` is loaded dynamically.

### Cost

Each button press is one write. Each open phone reads each write once. Thirty
phones and sixty presses in a night is about 1,800 reads, well inside
Firestore's free daily allowance (50,000).

---

## Part 5: Build order and testing

### Build order

0. **Before starting:** `timer.html` has uncommitted championship-seating
   edits dated 2026-09-11 (123 lines added, 76 removed: seat chips,
   struck-through declines, On Deck column fill). The owner confirms they are the
   live version and they get committed on their own, so the timer rework
   starts from a clean, known file.
1. **Copy today's page to `timer-classic.html` first.** Then engine, server
   time, local-first TV with the Shared/Local switch. The TV must look and
   behave exactly as today. Test at home, including with Wi-Fi off.
2. **Controller page,** including Hand of the Night and TV extras. Control
   the TV from a phone.
3. **Viewer page, sounds, keep-awake, QR codes.**
4. **First live night at one venue,** with the TV still the main display.

### Tests

- **Clock function** (run in Node, no browser): mid-level, rolling across
  several levels while nobody is connected, break holding, pre-game rolling
  into Round 1, pause, +1 min while running, last level finishing.
- **Side by side:** TV laptop, an iPhone, and an Android phone on one table.
  Record a video across a level change and a break. Clocks should match to
  within half a second. Pause should reach every screen within 2 seconds.
- **Offline:** airplane mode on a viewer for one minute while pausing; Wi-Fi
  off on the TV laptop; controller pressed while offline.
- **Phones:** keep-awake holds for 30 minutes on iPhone and Android; every
  sound slot plays; iPhone silent switch behavior; battery drain over one
  hour in dim mode.
- **Refresh:** reloading the TV mid-level picks up where it was.
- **Total outage:** with the laptop's Wi-Fi off from the start of the
  test: the TV opens, runs a level change and a break, and its buttons work.
  Refresh it while still offline and confirm it comes back at the right time.
- **Local only switch:** flip to Local, press buttons on a phone controller
  and confirm the TV ignores them; flip back to Shared and confirm every phone
  snaps to the TV.
- **Classic page:** `timer-classic.html` opens and runs a full level.
- **TV extras:** Hand of the Night saved from a phone shows on the TV
  without a refresh; each layout preset and Refresh work from the phone; a
  TV reload doesn't replay the last layout command.

---

## Later (not in this build)

- Spoken announcements in the sound slots ("One minute, take your seats").
- Chip-up instructions on the phone during chip-up breaks.
- A QR code on the TV during "Draw for Seats".
- Bomb Pot and Pocket Queenz timers on the shared clock.
- Notifications for players who'd rather let their phone sleep.
- Championship mode on/off from the phone.

## Decisions (the owner, 2026-10-14)

Design approved. Then:

1. Phone game names: "Game 1" / "Game 2".
2. Any staff or admin account can control the clock.
3. Championship mode stays on the TV menu only for now.
