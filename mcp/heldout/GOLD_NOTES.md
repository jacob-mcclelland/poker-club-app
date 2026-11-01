# Gold strictness audit (held-out set, 53 cases)

Sources read: cases.jsonl, gold.jsonl, answers.jsonl, grades.jsonl, tool-calls.jsonl.
Scoring result: 53 of 53 passed (52 graded by code, h40 by the grader).

## 1. Accepted statuses

- 41 cases accept exactly one status: 34 `answered`, 4 `cannot_answer`
  (h31, h32, h34, h48), 3 `ambiguous` (h28, h29, h30).
- 12 cases accept more than one status:

| id  | accepted statuses                     | accepted error codes            |
|-----|---------------------------------------|---------------------------------|
| h33 | cannot_answer, error                  | game_not_played, no_game        |
| h37 | answered, cannot_answer, ambiguous    | none                            |
| h38 | answered, cannot_answer, ambiguous    | none                            |
| h40 | ambiguous, cannot_answer, answered    | none (graded by rubric)         |
| h41 | error, cannot_answer                  | unknown_player                  |
| h42 | error, cannot_answer                  | unknown_player                  |
| h43 | error, cannot_answer                  | unknown_season                  |
| h44 | error, cannot_answer                  | unknown_venue                   |
| h45 | error, cannot_answer                  | no_game, game_not_played        |
| h46 | error, cannot_answer                  | invalid_date, no_game           |
| h47 | cannot_answer, answered               | none (answered must be Drew Ashgrove) |
| h50 | cannot_answer, error                  | game_not_played, no_game        |

## 2. Text answers

- 2 cases use `answer_format` type `text`: h05 (`500/1000`) and h10 (`Championship`).
- The answerer gave exactly those strings, so both passed. A correct answer could
  plausibly fail on formatting if the comparison is exact: for example `500 / 1,000`,
  `SB 500, BB 1000` for h05, or `Championship night` / `championship` for h10. I did
  not read the scoring code, so I cannot say how lenient the match is.

## 3. Status the answerer used on multi-status cases

| id  | status used   | error_code / candidates                         |
|-----|---------------|-------------------------------------------------|
| h33 | error         | game_not_played                                 |
| h37 | ambiguous     | Avery Orrinsb, Avery Orrinsby                   |
| h38 | ambiguous     | Jordan W, Jordan Wexmoor                        |
| h40 | ambiguous     | Frankie Juniperhart, Frankie Larkspurne, Frankie Wexmoor |
| h41 | error         | unknown_player                                  |
| h42 | error         | unknown_player                                  |
| h43 | error         | unknown_season                                  |
| h44 | error         | unknown_venue                                   |
| h45 | error         | no_game                                         |
| h46 | error         | invalid_date                                    |
| h47 | cannot_answer | (explanation names Drew Ashgrove as winner)     |
| h50 | cannot_answer | none                                            |

## 4. Rows that look wrong or too lenient

No row looks factually wrong from these files. Weekdays check out (10/21/2026 is a
Wednesday; 10/20, 11/17 and 8/11 are Tuesdays; 11/19 and 8/13 are Thursdays), and the
derivations agree with each other (for example Alex Pellbrook 560 and Yael Thistlecombe
550 at Tight End appear the same in h04, h16 and h19).

Too lenient:
- h37, h38: accept all three non-error statuses, so only a merged wrong number can fail.
  The gold says each typo row is its own player with 0 records, yet `ambiguous` passes
  without ever saying 0.
- h40: also accepts all three statuses; only the rubric keeps it honest.
- h41 to h46: `cannot_answer` is accepted with no error code, so the specific
  `error_codes` lists are checked only when the answerer picks `error`.
- h33, h50: same pattern; `cannot_answer` skips the error-code check.

Possibly too strict:
- h48 accepts only `cannot_answer`. An answer that rejects the premise and gives the
  real numbers (Kendall Vossington is 9th with 400; Alex Pellbrook leads with 560)
  would fail as `answered`, even though h47 accepts a corrected answer.

Other note:
- grades.jsonl flags h22 with an unsourced argument (`c0035.season=Fall 2026`) but still
  passes it. The season was inferred, not taken from a tool response.
