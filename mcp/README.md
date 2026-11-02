# Poker data for agents: an MCP server with a reliability test

Portfolio study #12. All data here is the generated demo club in `demo/fixtures`
(invented names, `example.com` emails). No real player, guest or venue data is used.

## What the study asks

How should league data reach agentic workflows, and how do you check that an
agent retrieves it reliably?

The answer built here: a small, read-only MCP server that exposes league data as
four typed, documented tools, plus a held-out eval in which three separate
subagents author the cases, answer them through the tools only, and grade the
one case that needs judgement, with every other case graded by code.

## Result (held-out run)

**A fresh answerer subagent, given only 53 held-out questions and the four MCP
tools, passed 53 of 53 cases written by a separate author subagent, using 73
logged MCP calls (69 cited as evidence). 52 cases were graded by code and 1 by
a third subagent. This is one run of one model on one synthetic club, so it
shows the tools support correct retrieval on these cases; it is not a
population pass rate.**

| Category | Cases | Passed | Cited calls |
|---|---:|---:|---:|
| straightforward | 15 | 15 | 16 |
| multi_step | 7 | 7 | 15 |
| tie | 5 | 5 | 6 |
| ambiguous | 3 | 3 | 4 |
| unanswerable | 4 | 4 | 5 |
| near_duplicate | 6 | 6 | 9 |
| unknown_entity | 6 | 6 | 6 |
| adversarial | 4 | 4 | 5 |
| championship | 3 | 3 | 3 |
| **Overall** | **53** | **53** | **69** |

Answer statuses used: 34 answered, 7 error, 6 cannot_answer, 6 ambiguous.
Failure kinds observed: none of the ten the scorer defines (see
`eval/heldout-score.js`). One answer (h22) passed a season argument that was
not in its question or an earlier response for it; that is flagged, not failed.
Category labels are the author's; 23 of the 53 cases are hard ones (ambiguous,
unanswerable, near-duplicate names, unknown entities, adversarial wording).

Where to look: `heldout/report.md` (per case), `heldout/PROVENANCE.md` (who
wrote what, commit hashes, file hashes), `heldout/GOLD_NOTES.md` (the grader's
audit of how strict the gold is).

## What was built

| Path | What it is |
|---|---|
| `server.js` | MCP server (stdio, official `@modelcontextprotocol/sdk`). Read-only tools, `readOnlyHint` set. |
| `schemas.js` | Input and output schemas (zod). Published as JSON Schema in `tools/list`; every result is validated against its output schema before it is sent. |
| `lib/` | Tool logic: data loading, name resolution, standings, history, seating, structure. |
| `heldout/` | Held-out run: cases, gold, answers, call log with responses, transcripts, grades, the three subagent prompts, provenance. |
| `eval/heldout-*.js`, `eval/evidence.js` | Answer contract, gold validator (prints no gold), evidence check against the call log, single-run scorer. |
| `eval/questions.jsonl` | Development run: 30 questions with expected answers and an answer format. |
| `eval/oracle.js`, `eval/build-questions.js` | Independent answer key and the script that builds the questions from it. |
| `eval/call.js` | The answerer's only access: one MCP tool call over stdio, logged with arguments and full response under a call id. |
| `eval/score.js`, `eval/compare.js` | Development-run scorer. Runs once; no override. |
| `eval/results/` | Development run: answers, call log (arguments only), score, report. |
| `test/` | 19 test declarations: tool behavior, agreement with the oracle, MCP protocol round trip, scorer and evidence rules. |

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

## How the held-out run worked

| Step | Who | What they saw | Output | Commit |
|---|---|---|---|---|
| 1. Author | fresh subagent | study question, fixtures, the app's rule code, tool descriptions, the answer contract. Not `mcp/lib`, the development set, or the server. | `heldout/cases.jsonl` (id and question only), `heldout/gold.jsonl` | `942d5be` (freeze) |
| 2. Answerer | fresh subagent | `cases.jsonl` and `eval/call.js`. Gold was moved out of the working tree for the whole run. | `heldout/answers.jsonl`, `heldout/tool-calls.jsonl`, `heldout/answerer-transcript.jsonl` | `0449c08` |
| 3. Grader | fresh subagent | cases, gold, answers, call log, a written rubric. No code. | `heldout/judge-grades.jsonl` (1 item) | `ca7f858` |
| 4. Scorer | code | everything above | `heldout/grades.jsonl`, `score.json`, `report.md` | `ca7f858` |

Decisions that make the number checkable:

- **Questions carry no hints.** `cases.jsonl` holds only id and question. One
  answer contract (answered, error, cannot_answer, ambiguous) applies to every
  case, so the format never reveals that an error is expected.
- **Evidence is checked, not self-reported.** Each answer cites call ids; the
  scorer accepts a citation only if the log holds that call under the same
  question. The log keeps every response, and the answerer's transcript is
  committed, so each answer can be traced from question to tool output.
- **Score once.** `eval/heldout-score.js` refuses to run if `grades.jsonl`
  exists and has no override. A second invocation was made and refused.
- **The builder never read gold.** `eval/heldout-check.js` validates gold
  and prints only counts. Grades omit expected values.

## Test boundaries

These are the limits of what the held-out number covers:

- **One model, separate contexts.** Author, answerer and grader are fresh
  subagents of the same model as the builder. Independence is of context, not
  of model.
- **Isolation by instruction.** The answerer had a shell. Gold was out of the
  working tree, and its transcript shows only `eval/call.js`, reads of
  `cases.jsonl`, and output trimming with `sed`, `grep`, `cut` and `tail`.
  This is an audit trail, not a sandbox.
- **Shared rules.** Gold was computed from the fixtures with the author's own
  code, but by the same league rules the server implements (the author
  mirrored `computeLeaderboard` and ran the app's `champ-seating.js`). An error
  in those rules would not show up here.
- **Lenient statuses on 12 of 53 cases.** 41 cases accept exactly one status;
  12 (h33, h37, h38, h40 to h47, h50) accept more than one, mostly unknown
  names reportable as the tool's error or as cannot_answer. The grader's audit
  calls two of them too lenient (h37 and h38 pass as "ambiguous" without
  stating the 0 the data gives) and found no gold row factually wrong. Two
  answers (h05, h10) are exact short text. `heldout/GOLD_NOTES.md` has the
  detail.
- **The builder wrote the answer contract and the status vocabulary**, which
  define what a correct refusal is.
- **Disclosure.** The author's hand-back message named two short expected text
  values to the builder after the freeze. The answerer never saw it.
- **Single run, 53 cases, synthetic data.** No run-to-run variance is measured.

## Development run (first run, kept for reference)

The first run was a developer demonstration, not an independent test. One agent
built the server, wrote 30 questions and their key (`eval/oracle.js`,
`eval/build-questions.js`), answered them through `eval/call.js`, and wrote
the scorer.

**One developer-agent run matched all 30 synthetic answer keys using 34
recorded MCP calls; independent retrieval reliability was not measured by it.**

| Question type | Questions | Passed | Tool calls |
|---|---:|---:|---:|
| standings | 4 | 4 | 4 |
| player_history | 5 | 5 | 5 |
| seating | 4 | 4 | 4 |
| structure | 4 | 4 | 4 |
| ties | 4 | 4 | 4 |
| unknown_names | 5 | 5 | 5 |
| multi_step | 4 | 4 | 8 |
| **Overall** | **30** | **30** | **34** |

What it could not show, and what changed because of it:

- The answering agent had written the key and saw each answer format, which
  revealed the four error cases (q22 to q25). `build-questions.js --show` now
  prints question text only, and the held-out cases carry no format.
- Some questions were picked for a unique answer (q11) or matched a tie example
  the tool returns (q21). The held-out author was told to choose hard cases
  from the data instead.
- The call log kept arguments, not responses, and the scorer trusted the
  answer's own list of calls. `call.js` now logs full responses under a call
  id, and both scorers check citations against the log (`eval/evidence.js`).
  Re-running that check on a scratch copy of the development run matched all
  34 citations and flagged q12, whose championship date appears in neither the
  question nor a logged response (q27 and q28 are also flagged, because that
  log has no responses to look in).
- The scorer had a `--force` rescore path. It is removed.

The development results in `eval/results/` were scored by the earlier scorer
(commit `1820384`) and are left as they were.

## Server checks

`npm test` runs 19 test declarations, all passing at the last commit. Among
them: the standings tool matches the development oracle row for row (rank,
name, points, games, wins, bounties, RSVPs) for all four venue seasons; for
the top 25 players per venue in Fall 2026, game-by-game points and bounties add
up to the standings totals; the MCP stdio round trip; and the scorer and
evidence rules, including `no_tool_evidence`, on synthetic cases.

## The design choice

**League data reaches agents through a narrow, read-only MCP server with typed
outputs and stable error codes.** This is a design choice for this app; no
alternative (raw database access, pasted exports, a SQL tool) was measured
against it here.

- Four tools answered all 53 held-out cases in at most a few calls each. Ranks,
  ties and per-game points come back settled the way the app settles them, so
  the agent does not reimplement scoring rules.
- Name resolution never guesses. In the held-out run, misspellings and partial
  names came back as errors with suggestions or were reported as ambiguous, and
  suggested names were not substituted.
- The server loads the app's own seating and clock modules, so the agent and the
  venue pages read one source of rules.

Gate for any change to the tools: `npm test` and a new held-out run (new author,
new answerer, scored once).

## Open questions

- **Unfinalized games.** Like the live leaderboard, standings count placements
  from a game that is not finalized yet (Tight End 10/20 game 2 in the demo). The
  tool flags it in `unfinalizedGames`. Should agents get finalized-only standings
  by default?
- **Live data.** This server reads fixture files. A live version would read
  Firestore with the Admin SDK under a read-only service account; the tool layer
  would not change.
- **Next eval steps.** A different model as answerer, an answerer run in a
  sandbox with no repository access, repeated runs to measure variance, and gold
  computed by rules written without reference to the app's code.
- **Demo data quirk.** The seed writes championship-night check-ins to game 1
  only, so game 2 of a championship shows every seat unconfirmed.

## Running it

```bash
cd mcp
npm install
npm test                                   # 19 tests
node server.js                             # stdio MCP server
node eval/call.js --list                   # tools as a client sees them
node eval/call.js --log /tmp/calls.jsonl --qid x1 get_season_standings '{"venue":"Wild Corgi","limit":5}'
node eval/heldout-check.js                 # validate held-out gold (prints counts only)
```

To use it from an MCP client, register the command `node /path/to/mcp/server.js`
(stdio). Optional environment: `POKER_DATA_DIR` (another fixture export) and
`POKER_AS_OF` (pins "today", which picks the current season).

A new held-out run follows the table above in a new folder: author subagent
writes cases and gold (commit), answerer subagent writes answers through
`call.js --log <folder>/tool-calls.jsonl` (commit), grader subagent judges any
`judge` items, then `node eval/heldout-score.js <folder>` runs once (commit).
