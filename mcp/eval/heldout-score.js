#!/usr/bin/env node
'use strict';
// Scores the held-out run once. No override, no re-score path.
//
// Reads heldout/{cases,gold,answers,tool-calls}.jsonl and, when gold marks an
// item `judge`, heldout/judge-grades.jsonl (written by the grader subagent).
// Writes heldout/grades.jsonl, score.json and report.md. Refuses to run if
// grades.jsonl exists. grades.jsonl carries the answerer's answer and the
// failure kind, not the expected answer.
//
// Failure kinds:
//   format_error        no answer, or not in the answer contract's shape
//   no_tool_evidence    no cited call, or a cited call id not logged for that question
//   wrong_value         number, date or text does not match
//   wrong_entity        wrong player, or wrong set of players or candidates
//   should_have_refused answered where the data says error, cannot answer, or ambiguous
//   false_error         reported a tool error where an answer exists
//   false_refusal       said cannot answer, or ambiguous, where an answer exists
//   wrong_status        refused for the wrong reason (for example error vs ambiguous)
//   wrong_error_code    right status, wrong error code
//   grader:<kind>       the grader subagent's failure kind on a judged item

const fs = require('fs');
const path = require('path');
const { gradeAnswer, goldProblems } = require('./heldout-rules');
const { checkEvidence } = require('./evidence');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'heldout'));
const f = (n) => path.join(dir, n);
const read = (n) => (fs.existsSync(f(n)) ? fs.readFileSync(f(n), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

if (fs.existsSync(f('grades.jsonl'))) {
  console.error('heldout/grades.jsonl exists: this run was already scored once.');
  process.exit(1);
}

const cases = read('cases.jsonl');
const gold = new Map(read('gold.jsonl').map(g => [g.id, g]));
const answers = new Map(read('answers.jsonl').map(a => [a.id, a]));
const log = read('tool-calls.jsonl');
const judged = new Map(read('judge-grades.jsonl').map(j => [j.id, j]));

for (const [id, g] of gold) { const p = goldProblems(g); if (p.length) throw new Error(`gold ${id}: ${p.join('; ')}`); }
for (const c of cases) if (gold.get(c.id).judge && !judged.has(c.id)) throw new Error(`${c.id} needs a grader verdict in judge-grades.jsonl`);

const rows = cases.map(c => {
  const g = gold.get(c.id);
  const a = answers.get(c.id);
  const ev = a ? checkEvidence(c.id, c.question, a.call_ids, log) : null;
  let failure, gradedBy = 'code';
  if (!a) failure = 'format_error';
  else if (!ev.ok) failure = 'no_tool_evidence';
  else if (g.judge) {
    const j = judged.get(c.id);
    gradedBy = 'grader';
    failure = j.pass ? null : `grader:${j.failure || 'unspecified'}`;
  } else failure = gradeAnswer(g, a);
  return {
    id: c.id, category: g.category, pass: !failure, failure, graded_by: gradedBy,
    status: a ? a.status : null, answer: a ? a.answer ?? null : null, error_code: a ? a.error_code ?? null : null,
    candidates: a ? a.candidates ?? null : null,
    calls: ev ? ev.matched.length : 0, invalid_citations: ev ? ev.invalid : [], unsourced_args: ev ? ev.unsourced : []
  };
});

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : 'n/a');
const cats = [...new Set(rows.map(r => r.category))];
const byCategory = cats.map(c => {
  const r = rows.filter(x => x.category === c);
  return { category: c, cases: r.length, passed: r.filter(x => x.pass).length, calls: r.reduce((a, x) => a + x.calls, 0) };
});
const failures = rows.filter(r => !r.pass).reduce((m, r) => ({ ...m, [r.failure]: (m[r.failure] || 0) + 1 }), {});
const passed = rows.filter(r => r.pass).length;
const summary = {
  scoredAt: new Date().toISOString(),
  cases: rows.length, passed, passRate: pct(passed, rows.length),
  loggedCalls: log.length, citedCalls: rows.reduce((a, r) => a + r.calls, 0),
  gradedByCode: rows.filter(r => r.graded_by === 'code').length,
  gradedByGrader: rows.filter(r => r.graded_by === 'grader').length,
  answersWithUnsourcedArgs: rows.filter(r => r.unsourced_args.length).length,
  byCategory: byCategory.map(b => ({ ...b, passRate: pct(b.passed, b.cases) })),
  failures
};
fs.writeFileSync(f('grades.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(f('score.json'), JSON.stringify(summary, null, 1) + '\n');
const md = [
  '# Held-out score', '',
  `Scored once at ${summary.scoredAt}. Answers were committed before scoring (see PROVENANCE.md).`, '',
  `**Overall: ${passed} of ${rows.length} cases passed (${summary.passRate}).** ${summary.citedCalls} cited calls out of ${summary.loggedCalls} logged. ${summary.gradedByCode} graded by code, ${summary.gradedByGrader} by the grader subagent.`, '',
  '| Category | Cases | Passed | Pass rate | Cited calls |', '|---|---:|---:|---:|---:|',
  ...summary.byCategory.map(b => `| ${b.category} | ${b.cases} | ${b.passed} | ${b.passRate} | ${b.calls} |`), '',
  '## Failure kinds', '',
  ...(Object.keys(failures).length ? ['| Kind | Count |', '|---|---:|', ...Object.entries(failures).map(([k, v]) => `| ${k} | ${v} |`)] : ['None.']), '',
  '## Per case', '',
  '| Id | Category | Result | Failure | Graded by | Calls | Unsourced args |', '|---|---|---|---|---|---:|---|',
  ...rows.map(r => `| ${r.id} | ${r.category} | ${r.pass ? 'pass' : 'FAIL'} | ${r.failure || ''} | ${r.graded_by} | ${r.calls} | ${r.unsourced_args.join(', ')} |`), ''
].join('\n');
fs.writeFileSync(f('report.md'), md);
console.log(md.split('\n').slice(0, 30).join('\n'));
