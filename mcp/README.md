# Poker data for agents: an MCP server with a reliability test

Portfolio study #12. All data here is the generated demo club in `demo/fixtures`
(invented names, `example.com` emails). No real player, guest or venue data is used.

## What the study asks

How should league data reach agentic workflows, and how do you check that an
agent retrieves it reliably?

The answer built here: a small, read-only MCP server that exposes league data as
four typed, documented tools, plus an eval that makes an agent answer 30 questions
only through those tools, freezes the answers, and scores them once against an
answer key computed by separate code.

## What was built

| Path | What it is |
|---|---|
| `server.js` | MCP server (stdio, official `@modelcontextprotocol/sdk`). Read-only tools, `readOnlyHint` set. |
| `schemas.js` | Input and output schemas (zod). Published as JSON Schema in `tools/list`; every result is validated against its output schema before it is sent. |
| `lib/` | Tool logic: data loading, name resolution, standings, history, seating, structure. |
| `eval/questions.jsonl` | 30 questions with expected answers and an answer format. |
| `eval/oracle.js`, `eval/build-questions.js` | Independent answer key and the script that builds the questions from it. |
| `eval/call.js` | The agent's only access during the eval: one MCP tool call over stdio, logged. |
| `eval/score.js`, `eval/compare.js` | Scorer. Runs once; refuses to overwrite an existing score. |
| `eval/results/` | `answers.jsonl` (frozen answers), `tool-calls.jsonl` (every call), `score.json`, `report.md`. |
| `test/` | 17 tests: tool behavior, agreement with the oracle, MCP protocol round trip, scorer rules. |

### The four tools

| Tool | Input | Returns |
|---|---|---|
| `get_season_standings` | `venue`, optional `season`, `limit` | Ranked rows (rank, tied, points, games played, wins, bounties, RSVPs honored, berth), the season window, and any unfinalized games already counted. |
| `get_player_season_history` | `player`, optional `venue`, `season` | How the name resolved (exact, normalized or alias) and look-alike roster rows; season totals (rank, points, best finish, and so on) and every game with finish, points and bounties. Without `venue`, both venues. |
| `get_game_seating` | `venue`, `date`, `game` | Regular night: the field in check-in order with finishes, and the final table. Championship night: the director's seating chart (playing, cleared, on deck, consolation, waitlist, out) with summary counts. |
| `get_game_structure` | optional `venue`, `date` | Blind levels with minutes, start minute, blinds and chip-ups; points table; tie and attendance rules; championship seating rules; and, with a date, the event type and whether it counts toward the season. |

Design choices that matter for agents:

- **One source of rules.** Standings follow `computeLeaderboard` in
  `functions/index.js` (points, three tiebreaks, attendance once per game, no
  championship nights). Seating and blind levels load the app's own
  `public/champ-seating.js` and `public/clock-structures.js`, so the server and
  the venue pages cannot drift apart.
- **No guessing on names.** A name resolves only on an exact match after trimming,
  collapsing spaces and lowercasing, or on a roster alias. Anything else is an
  `unknown_player` error with up to three suggestions. The agent can offer a
  suggestion; the server never substitutes one.
- **Stable error codes.** `unknown_player`, `ambiguous_player`, `unknown_venue`,
  `unknown_season`, `invalid_date`, `no_game`, `game_not_played`,
  `invalid_argument`, each with the valid options attached (venues, seasons,
  nearest event dates).
- **Shows what a person would want flagged.** Unfinalized games that already count,
  roster rows that look like duplicates, and that regular-night seats are drawn
  at the table and not recorded.

## How it was run

1. Built the server and tests, then built the 30 questions with
   `node eval/build-questions.js`. The expected answers come from `eval/oracle.js`,
   which reads the fixtures directly and shares no code with `lib/`. The build
   script prints only the question text, so the agent never saw the key.
   Questions and key were committed before answering.
2. The agent (Claude, in the session that built this) answered each question
   using only `node eval/call.js --qid <id> <tool> '<json>'`. That client talks
   to `server.js` over the real MCP protocol and logs every call. 34 calls for 30
   questions.
3. Answers were written to `eval/results/answers.jsonl` and committed
   (commit "freeze the agent's 30 answers before scoring") before the scorer ran.
4. The scorer's comparison rules were unit-tested on synthetic cases, then the
   scorer ran once. It was started by loading `eval/score.js` from node directly,
   not through `npm run eval:score`; it is the same code and the only run. A
   second run is refused.

Question mix:

| Type | Count | What it checks |
|---|---:|---|
| standings | 4 | leader, leader's points, most bounties (set answer), count of winners |
| player_history | 5 | games played, best finish, bounties, date of a win, lookup by roster alias |
| seating | 4 | field size, first to check in, director's consolation move, unconfirmed championship seats |
| structure | 4 | blinds at a level, start minute of a level, points for a finish, event type on a date |
| ties | 4 | tied finish and its split points, shared standings rank, tiebreak between equal points, three-way tie rule |
| unknown_names | 5 | made-up player, misspelled real player, missing season, missing venue, rostered player with no games |
| multi_step | 4 | two tool calls each: winner then rank, leader then nightly bounties, final table then standings, two venues compared |

## Result

| Question type | Questions | Passed | Pass rate | Tool calls |
|---|---:|---:|---:|---:|
| standings | 4 | 4 | 100% | 4 |
| player_history | 5 | 5 | 100% | 5 |
| seating | 4 | 4 | 100% | 4 |
| structure | 4 | 4 | 100% | 4 |
| ties | 4 | 4 | 100% | 4 |
| unknown_names | 5 | 5 | 100% | 5 |
| multi_step | 4 | 4 | 100% | 8 |
| **Overall** | **30** | **30** | **100%** | **34** |

Failure kinds observed: none. The scorer classifies misses as `wrong_value`,
`wrong_entity`, `partial`, `should_have_errored`, `false_error`,
`wrong_error_code`, `format_error` and `no_tool_evidence`; all eight are tested
in `test/score.test.js`.

Server correctness is checked separately from the agent: the standings tool
matches the independent oracle row for row (rank, name, points, games, wins,
bounties, RSVPs) for all four venue seasons, and every player's game-by-game
points add up to their standings total.

How to read 30/30: with 30 questions, the 95% lower confidence bound on the true
pass rate is about 89% (Wilson). This is one run by one agent, which also wrote
the server, so the result shows the tools are answerable and unambiguous. It
does not yet measure how a different agent or model reads them.

## The decision it supports

**Give agents league data through a narrow, read-only MCP server with typed
outputs and stable error codes, not raw database access or pasted exports.**

- Four tools covered all 30 questions, including multi-step ones, in at most two
  calls each. The agent never had to recompute scoring rules; the tools return
  ranks, ties and per-game points already settled the way the app settles them.
- Unknown players, seasons and venues all came back as explicit error codes, and
  the agent reported them rather than answering. The misspelled-name case is the
  one that matters: the suggestion was available and was not substituted.
- Reusing the app's own seating and clock modules keeps one source of truth.

Gate for any change to the tools: `npm test` (17 tests, including the oracle
cross-check) and a fresh eval run (new answers file, scored once).

## Open questions

- **Unfinalized games.** Like the live leaderboard, standings count placements
  from a game that is not finalized yet (Tight End 10/20 game 2 in the demo). The
  tool flags it in `unfinalizedGames`. Should agents get finalized-only standings
  by default?
- **Live data.** This server reads fixture files. A live version would read
  Firestore with the Admin SDK under a read-only service account; the tool layer
  would not change.
- **Harder eval.** Next steps: run a different model through the same 30
  questions, add paraphrased and adversarial wording, and add questions whose
  answer is "the data cannot say" (for example, regular-night seat numbers).
- **Demo data quirk.** The seed writes championship-night check-ins to game 1
  only, so game 2 of a championship shows every seat unconfirmed.

## Running it

```bash
cd mcp
npm install
npm test                                   # 17 tests
node server.js                             # stdio MCP server
node eval/call.js --list                   # tools as a client sees them
node eval/call.js get_season_standings '{"venue":"Wild Corgi","limit":5}'
node eval/build-questions.js               # rebuild questions (prints text only)
```

To use it from an MCP client, register the command `node /path/to/mcp/server.js`
(stdio). Optional environment: `POKER_DATA_DIR` (another fixture export) and
`POKER_AS_OF` (pins "today", which picks the current season).

A new eval run needs a fresh `eval/results/` (move the old one aside), answers
written to `answers.jsonl` from `call.js` output only, a commit, then
`npm run eval:score`.
