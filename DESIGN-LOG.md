# Design log

Dated design decisions from the private history of this app, from the first version in December 2025. Each entry says what was decided and how it works now. They are condensed from about 170 commit messages; player names, money and private details are left out. Some calls were mine, some came from the agents that wrote the code, and some came from independent reviews; entries say so where the record does.

## 2025-12-16: First version on a spreadsheet backend

A check-in kiosk, RSVP, a director page and a leaderboard, with Google Sheets and Apps Script behind them. It ran on a real game night from the start, and each night's notes shaped the next round: a larger kiosk input, undo on every entry, and pages that refresh on their own.

## 2026-01-13: The database becomes the source of truth

The logic moved into Cloud Functions and Firestore, and the spreadsheet stayed on for a while as a backup transcript. Eliminations wait for the write to land before the screen updates, so what staff see is what was saved. Bounties update instantly, because entry speed matters more there.

## 2026-01-19: One leaderboard over three record formats

Records from three eras store points differently: a total, bonus points, or an old import where a rank above 10 means a total. Rather than rewrite history, the leaderboard reads each format through its own branch and recomputes the standings from the raw records on every request.

## 2026-01-20: The venue timer, built from a written specification

The TV timer was specified first (overview, features, technical design, layout, a task list and a test plan, in `docs/timer-prd/`) and then built against it. The kiosk type got larger the same week, so it reads easily for older players.

## 2026-03-27: Championship night

Championship night got its own director flow. The director's moves are saved on the server as they happen, so a phone refresh in the middle of the night picks up where it left off. The change shipped with its own written rollback plan.

## 2026-04-14: Redesign and self check-in at the venue

A visual redesign, and a self check-in that confirms the player is at the venue.

## 2026-05-30: Schedules move off the spreadsheet

A tagged restore point came first. Moving an event writes the new record, carries its content across, and deletes the old one in a single batch, so an event is never half moved. Scheduling on an off night asks for confirmation rather than refusing.

## 2026-06-12: Admin sign-in with roles checked on the server

Admins sign in, and every server call checks the caller's role. Thresholds live in config, admin scripts stay out of the deployed bundle, and bumping the cache version is part of the deploy contract.

## 2026-06-18: One name matcher everywhere

Every page that looks up a player uses the same matcher: nickname, alias, fuzzy match, and a list of short names that must never fuzzy-match. The spreadsheet integration was retired.

## 2026-06-25: A review step before finalize

Before results are written, a read-only review returns FULL, PARTIAL or BLOCK and lists anything a person should look at. It counts tied players rather than distinct ranks. If the review itself cannot run, the director can still close the night with "Finalize anyway", and that submission is logged as unverified, so a check never stands between staff and the end of a night.

## 2026-06-26: Drink rounds at the bar

Players order drink rounds from their phones and the bar works from a live board. Totals are derived from the list of rounds every time they are read and are never stored as a running count, because Firestore deep-merges map fields. Every uncaught page error shows a banner and is recorded.

## 2026-07-22: The club's clock, not the server's

Cloud Functions run in UTC and the club runs on Mountain time, so every server-side "today" is pinned to America/Denver and a game night is one date from setup to close. Any change to stored data goes through a read-only audit script first.

## 2026-08-10: Uploads require sign-in

Uploads require a signed-in user.

## 2026-08-28: Finalize checks the night's own data

The finalize review compares records against that night's own data, so routine edits such as removing and re-adding a player go through, and only a real contradiction blocks.

## 2026-09-04: Late credit and a careful roster sweep

Staff can give a player attendance credit after a game is finalized. The roster sweep proposes merges and never merges on its own, asks once per group, and remembers pairs that were declined. Unused code came out: the functions file went from 5,889 to 5,518 lines and from 65 to 60 exported functions.

## 2026-09-05: Security rules built from every read and write

The rules list every collection and who may read or write it, derived from every direct read and write the pages make, and anything unlisted is denied. They were tested signed out and signed in before release, and the same cases now run offline on the Firestore emulator.

## 2026-09-05: Championship seating

One shared seating module and one definition of an open seat serve every championship screen. Tiebreaks are the same everywhere: games played, then honoured RSVPs. An empty date stays empty; a placeholder string never stands in for one.

## 2026-10-03: Checks before anything is sent

Push messages, event pages, player names and custom email blasts are checked locally, against expectations frozen before any live model call. The checks list things for a person to read and never block or rewrite.

## 2026-10-08: A second app on the same project

An event contest app runs on the same Firebase project, with rules that keep its anonymous visitors from counting as signed-in players.

## 2026-10-14: The synced clock

The clock is stored as an anchor ("at server time T there were N ms left on level L"), not as a ticking count, with a measured offset from server time, so every screen agrees and the TV keeps running offline. The previous timer page stays available as a fallback. Independent reviews checked how refused, stale and out-of-order button presses interact before release, and a log of presses makes any pause traceable.

## 2026-10-14: Offline support and a release rhythm

The service worker caches only the site's own files and deletes only its own old caches, because the venue timer runs a worker of its own. A dependency-free check runs before every release. Releases go out weekly on Saturdays, never on a game night.

## 2026-10-16: Player emails kept on the server

Player records are readable without signing in, because the venue kiosk runs signed out. Emails live in a separate collection that only the server can read. The move kept a local backup, copied each email, read the copy back, and cleared the original only when the copy matched, inside a transaction.

## 2026-10-19: Staff and admin edits go through the server

Only the linked player, staff or an admin may replace a player's email. The admin game inspector writes through a server function that checks each row id. Drink orders come from a signed-in session (the order page signs in anonymously), and the rules check every field of a round. Each change has a test on the Firestore emulator, and a review from a different model family read them before they went live on 2026-10-21.

## 2026-10-21: The clock follows the night

The players' clock bubble and the staff clock remote open on the game that matters at that moment: Game 1 before 9 pm, Game 2 from 9 pm once its clock has started. Both use one rule, with its own test.

## 2026-10-22: How this copy was prepared

- The app files were copied from the private main line by an explicit list, read from git objects so the live working tree was never touched.
- The live project's identifier (in 23 of the 162 copied files) and its public web key (in 7) now point at a demo project that exists only in the emulator.
- Player names in the bar's demo page and in the roster cleanup's list of declined pairs are generated.
- Photos of people are replaced with neutral art of the same size, so every page and the service worker check work as they do in the live app.
- The demo data comes from a seeded script. A check fails if the fixtures differ from a fresh run, or if any file holds something that looks like a real email, phone number, key, project id, hosted address or local path. The generated names were compared with every file in the private history, and none match.
- Billing is shown with sample invoices: generated check-ins at two invented venues become invoices at a $6 demo rate, marked as sample data. The sample code refuses to invoice the club's real venues.
- Left out of this copy: a host assistant on the staff night page, a player help desk, and the button for a separate event contest app.
