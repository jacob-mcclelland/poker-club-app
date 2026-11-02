# Provenance of the held-out run

Branch `mcp-server`. Commits in order:

| # | Commit | What it froze |
|---|---|---|
| 0 | `3f904c6` | Builder: call log with responses, evidence check, held-out answer contract and scorer, no rescore path. Written before any case existed. |
| 1 | `942d5bea41b04546c734db0e13d58ebce556f10d` | **Freeze.** Author's cases and gold, before anything was answered. |
| 2 | `0449c08607cde77cc504b0f9100992fd941bb9d9` | Answerer's answers, call log and transcript. |
| 3 | `ca7f858d67b248ee85754afc752e586a77f52730` | Grader's verdict and the single scoring run. |

SHA-256 of each frozen file, taken from the commit that froze it:

| File | Commit | SHA-256 |
|---|---|---|
| cases.jsonl | 942d5be | `03d4fb9760dfd4da1d2d4b537f43806b6a17375be0def4d31c0ba56ef470ece2` |
| gold.jsonl | 942d5be | `5d9e9791bab9aa9f9f0290e6a0dd238b9cbc5a006042f9eb237a88d7f2e1c1c1` |
| AUTHOR_PROMPT.md | 942d5be | `3899a5ebaa5be5275723831d335847fad05b511b3930fc5ac55e1870aff448ff` |
| answers.jsonl | 0449c08 | `c9d63e19fec207eade06453946a28a7a35818531023c42537dfdee21785fca6b` |
| tool-calls.jsonl | 0449c08 | `0f1ec1914a9eb633df814a35819dc5572fe1ed37f044ffcf3bbbc6ad4e2f41ae` |
| answerer-transcript.jsonl | 0449c08 | `004aca23686d1a33957c110477bfe30166f4936700cfd63fdf94f850634fce5b` |
| ANSWERER_PROMPT.md | 0449c08 | `05ede8c08914722ee4377f086954554324d41478b77e5f938e5afa74183ad9df` |
| judge-grades.jsonl | ca7f858 | `6a93f26aaa62bbb05a86cc2a4aa91441165eed06405e434f5b8aaa4f9163dea6` |
| grades.jsonl | ca7f858 | `74df2e261a28678cccbe3e59cbac64e363234492f337a71a280f80d0e90967b8` |
| score.json | ca7f858 | `1477dd601286e9b199e0d3bed3e49c505aac4258d71e61590c0ea238c8a37ad6` |

Check: `git show <commit>:mcp/heldout/<file> | sha256sum`.

## Who wrote what

| File | Written by |
|---|---|
| AUTHOR_PROMPT.md, ANSWERER_PROMPT.md, GRADER_PROMPT.md | Builder (the session that built the server). Each subagent was started with a one-line prompt pointing at its file; follow-up messages are quoted verbatim at the end of each file. |
| cases.jsonl, gold.jsonl, author-work/ | Author subagent (fresh context). author-work/ is its helper code, kept outside the repository until after scoring and added in the commit after #3. |
| answers.jsonl, tool-calls.jsonl | Answerer subagent (fresh context), through `eval/call.js`. |
| judge-grades.jsonl, GOLD_NOTES.md | Grader subagent (fresh context). GOLD_NOTES.md was requested after scoring. |
| grades.jsonl, score.json, report.md | `eval/heldout-score.js`, run once. A second invocation was refused. |
| author-, answerer-, grader-transcript.jsonl | `eval/extract-transcript.js` from each subagent's session log (prompt, its text, tool calls, results cut at 4,000 characters; harness reminders dropped). The author and grader transcripts were added after scoring. |
| PROVENANCE.md, README.md | Builder. |

## Handling notes

- The builder did not open gold.jsonl. It ran `eval/heldout-check.js`, which prints counts only.
- gold.jsonl was moved out of the working tree while the answerer ran and restored before commit #2. Its hash above is from commit #1.
- The answerer's own hand-back counted 33 answered and 7 ambiguous; the committed file and grades have 34 and 6. The file is what was scored.
- The author's hand-back to the builder named two expected text values after the freeze (h05, h10). The answerer did not see it.
