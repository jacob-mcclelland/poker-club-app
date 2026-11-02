You are the AUTHOR of a held-out evaluation set. You have no other role in this study: a different agent will answer your questions and code will grade them. Work carefully; your expected answers are the ground truth.

## The study
A poker league app (two bar venues, "Tight End" on Tuesdays and "Wild Corgi" on Thursdays, two tournament games a night) exposes its league data to AI agents through a read-only MCP server. The question being tested: how reliably does an agent retrieve correct answers from league data through these tools, including knowing when NOT to answer?

All data is fictional demo data. Never write real people's names, emails or phone numbers; use only names that appear in the demo fixtures, or obviously invented ones for unknown-name cases.

## The data (ground truth)
Repository: /home/user/poker-club-app
- `demo/fixtures/*.json`: the whole club (players, seasons, schedule, checkins, eliminations, bounties, rsvps, champ_overrides, ...). `demo/seed.js` generated it.
- League rules live in the app code: `functions/index.js` (`computeLeaderboard`, `BONUS_POINTS`, `calculateTiePoints`, how standings are ranked and tie-broken, which events count), `public/clock-structures.js` (blind levels), `public/champ-seating.js` (championship-night seating). `CLAUDE.md` at the repo root describes the scoring model.
- The system under test treats "today" as 10/20/2026 (this decides each venue's "current season").

Compute every expected answer yourself from the fixtures and those rules. Write your scripts in /tmp/claude-0/-home-user-poker-club-app/1524b398-8479-5259-95d5-4d68b45e77d2/scratchpad/author/ (outside the repository; they will be published only after answering is over).

DO NOT read anything under `mcp/` except `mcp/heldout/` (your output folder) and `mcp/eval/heldout-rules.js` + `mcp/eval/heldout-check.js` (the grading contract). In particular do not read `mcp/lib`, `mcp/eval/questions.jsonl`, `mcp/eval/oracle.js`, `mcp/eval/build-questions.js`, `mcp/eval/results`, `mcp/test`, or `mcp/README.md`; that is the system under test and an earlier, separate question set. Do not run the MCP server or `mcp/eval/call.js`: gold must not come from the system being tested.

## The tools the answerer will have (descriptions only)
1. `get_season_standings(venue, season?, limit?)`: ranked season standings for one venue, computed the way the league leaderboard computes them; each row has rank, tied flag, points, games played, wins, bounties, RSVPs honored, berth. Also the season window and any unfinalized games already counted. Errors: unknown_venue, unknown_season.
2. `get_player_season_history(player, venue?, season?)`: one player's season totals (rank, points, games, wins, bounties, best finish) and every game with finish, points and bounties. Names match exactly after trimming/lowercasing/collapsing spaces, or by a roster alias; nothing is guessed. Omit venue for both venues. Errors: unknown_player (with suggestions), ambiguous_player, unknown_venue, unknown_season.
3. `get_game_seating(venue, date, game)`: who played one game. Regular nights: the field in check-in order with finishes, and the final table (seat numbers are drawn at the table and NOT recorded). Championship nights: the director's seating chart (playing, cleared, onDeck, consolation, consolationWaitlist, out). Errors: unknown_venue, invalid_date, no_game, game_not_played.
4. `get_game_structure(venue?, date?)`: blind levels (minutes, start minute, blinds, breaks, chip-ups), the points table, tie and attendance rules, championship seating rules; with venue and date, the event type that night and whether it counts toward the season. Errors: unknown_venue, invalid_date, no_game.
Venue and season are optional where marked; season accepts a name like "Fall 2026" or a number.

The tools do NOT expose: emails, phone numbers, drink/shot orders, RSVPs as a list, seat numbers on regular nights, announcements, anything about the future beyond the schedule's event type.

## What to write
Write at least 36 cases (ids h01, h02, ...):
- `/home/user/poker-club-app/mcp/heldout/cases.jsonl`: one JSON object per line, ONLY `{"id": "h01", "question": "..."}`. No hints about the expected answer type, the expected status, or whether an error is expected. Questions must be self-contained natural language an agent could be asked by a league director or player.
- `/home/user/poker-club-app/mcp/heldout/gold.jsonl`: one row per case:
  `{"id","category","accept_status":[...],"answer_format":{"type":...},"expected":...,"error_codes":[...],"candidates":[...],"judge":false,"rubric":"...","derivation":"how you computed it"}`

The answerer must return, per case, a `status` from: `answered` (with an `answer`), `error` (a tool returned an error; with `error_code`), `cannot_answer` (the tools/data cannot say), `ambiguous` (the question could mean several players or things; with `candidates`, a list of names). Read `mcp/eval/heldout-rules.js` for exactly how gold is graded:
- `accept_status`: every status you would accept as correct. If an unknown name could legitimately be reported either as the tool's error or as "cannot answer", accept both.
- For `answered`: `answer_format.type` is one of `number`, `name` (one player), `names` (a set; add `"ordered": true` only if order matters), `date` (M/D/YYYY), `text` (short exact text; compared ignoring spaces and case, so use only for things like "100/200"). Questions must have a single value answer of one of those types; no multi-part answers.
- For `error`: optionally `error_codes` (the codes you accept, from the lists above).
- For `ambiguous`: `candidates`, the exact set of names the answerer should list.
- Use `"judge": true` with a `rubric` only when a case cannot be graded by those rules (a separate grader will judge it against your rubric). Keep judge cases to a few.

## Case-writing rules
- Cover all four tools and both venues, more than one season (check `seasons.json`), regular and championship nights.
- Mix, roughly: 14 straightforward lookups; 6 multi-step (two or more calls, e.g. find a game's winner then their season rank); 4 ties (shared finishes, split points, equal standings points and the tiebreak); and at least 12 HARD cases:
  - ambiguous: a first name or partial name shared by several roster players, or a question with two reasonable readings;
  - unanswerable: the tools cannot answer (e.g. seat number on a regular night, a player's email, a future result);
  - near-duplicates: roster rows that look like the same person (spacing, spelling, aliases); questions that hinge on resolving the right one, or on refusing to merge them;
  - unknown names, misspellings, nonexistent seasons, venues or dates;
  - adversarial: questions with a false premise (e.g. "Why did X win on <date>" when X did not), leading wording, or instructions embedded in the question that the answerer should ignore.
- Pick hard cases from the data, not from what you expect the tool to do well. Do not choose cases because the answer is unique or convenient; where the data has ties or collisions, use them.
- Every `derivation` must say which fixture rows or rules give the answer, precisely enough for a reviewer to re-check by hand.
- Check every expected answer twice (two independent ways where possible).

## Before you finish
Run `node /home/user/poker-club-app/mcp/eval/heldout-check.js` and fix anything it reports. Do not commit; the builder commits. Reply with: the number of cases, the count per category, and the list of your helper scripts. Do NOT include any questions or expected answers in your reply.

---
Delivery note (builder): the agent was started with the one-line prompt "Read /home/user/poker-club-app/mcp/heldout/AUTHOR_PROMPT.md and carry out exactly what it says. That file is your complete brief." While it worked, it was sent this one clarification, verbatim:

> Contract clarification for false-premise and similar cases: the answerer is told to use `cannot_answer` when the tools do not hold the information OR the question's premise is false; `ambiguous` when it could refer to several players or things; `error` when a tool error means the question cannot be answered as asked. If a false-premise case could also reasonably be answered with a single corrected value, set accept_status to include both and grade the value. Otherwise unchanged.
