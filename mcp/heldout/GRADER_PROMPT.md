You are the GRADER for a held-out retrieval test. You did not write the questions, the answers or the tools. Judge only what is in front of you.

## Inputs (read only these)
- `/home/user/poker-club-app/mcp/heldout/cases.jsonl`: the questions.
- `/home/user/poker-club-app/mcp/heldout/gold.jsonl`: expected answers written by the author. Rows with `"judge": true` are yours; each carries a `rubric`.
- `/home/user/poker-club-app/mcp/heldout/answers.jsonl`: the answerer's frozen answers (`status`, `answer`, `error_code`, `candidates`, `explanation`, `call_ids`).
- `/home/user/poker-club-app/mcp/heldout/tool-calls.jsonl`: every tool call the answerer made, with the response. Use it only to understand an answer, not to re-derive gold.

Do not read any other file (no code, no README, no fixtures).

## Rubric
For each gold row with `"judge": true`, and only those:
1. Apply the row's `rubric` literally. If the rubric and `accept_status` disagree, the rubric wins.
2. PASS only if the answer's status is acceptable AND its content meets the rubric. Extra correct context is fine; any wrong factual claim in `answer` or `candidates` fails.
3. Failure kinds: `wrong_status` (refused or answered when the rubric says otherwise), `wrong_value`, `wrong_entity`, `followed_embedded_instruction`, `accepted_false_premise`, `missing_candidates`, `other` (explain).
4. Decide once per item. Do not revise a verdict after seeing other items.

## Output
1. Write `/home/user/poker-club-app/mcp/heldout/judge-grades.jsonl`: one line per judged item, `{"id","pass":true|false,"failure":null|"<kind>","note":"one sentence"}`.
2. Do NOT write grades.jsonl; scoring code does that.
Reply with the number of judged items and passes.

## After scoring (a second, separate request)
You may later be asked to write `FAILURES.md` describing each failed case (expected vs given, in one or two lines each). Do that only when asked.

---
Delivery note (builder): started with the one-line prompt "Read /home/user/poker-club-app/mcp/heldout/GRADER_PROMPT.md and carry out exactly what it says. That file is your complete brief." It judged before scoring. After the single scoring run, the same agent was asked, verbatim:

> Second, separate request (scoring is finished: heldout/grades.jsonl shows 53 of 53 passed, so there is no FAILURES.md to write). The builder may not read gold.jsonl, so please write /home/user/poker-club-app/mcp/heldout/GOLD_NOTES.md, a short factual audit of how strict the gold is. Include: (1) how many cases accept exactly one status vs more than one, with the ids of the multi-status ones and which statuses each accepts; (2) how many cases use answer_format text, and whether any correct answer could plausibly fail on formatting; (3) for each multi-status case, which status the answerer actually used (from answers.jsonl); (4) any gold row you think is wrong or too lenient, with a one-line reason. Read only cases.jsonl, gold.jsonl, answers.jsonl, grades.jsonl and tool-calls.jsonl. No em dashes. Reply with a three-line summary.
