#!/usr/bin/env node
'use strict';
// Scores eval/results/answers.jsonl against eval/questions.jsonl, once.
// Writes results/score.json (per question) and results/report.md (tables).
// Refuses to run if a score already exists: answers are frozen before scoring
// and scored a single time. There is no override.
//
// Failure kinds:
//   wrong_value         a number, date or text that does not match
//   wrong_entity        the wrong player (or set of players)
//   partial             a multi-field answer with some fields wrong
//   should_have_errored answered a question about an unknown name, season or venue
//   false_error         reported an error where an answer exists
//   wrong_error_code    reported the wrong kind of error
//   format_error        answer missing or in the wrong shape
//   no_tool_evidence    a cited tool call is not in the call log for that question

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = path.join(DIR, 'results');
const readJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

if (fs.existsSync(path.join(OUT, 'score.json'))) {
  console.error('results/score.json exists: these answers were already scored once.');
  process.exit(1);
}

const questions = readJsonl(path.join(DIR, 'questions.jsonl'));
const answers = new Map(readJsonl(path.join(OUT, 'answers.jsonl')).map(a => [a.id, a]));

const log = readJsonl(path.join(OUT, 'tool-calls.jsonl'));
const { compare } = require('./compare');
const { checkEvidence } = require('./evidence');

const rows = questions.map(q => {
  const a = answers.get(q.id);
  let failure = null;
  const ev = a ? checkEvidence(q.id, q.question, a.tool_calls, log) : null;
  if (!a) failure = 'format_error';
  else if (!ev.ok) failure = 'no_tool_evidence';
  else failure = compare(q.answer_format, q.expected, a.answer);
  return { id: q.id, type: q.type, pass: !failure, failure, toolCalls: ev ? ev.matched.length : 0, unsourcedArgs: ev ? ev.unsourced : [], expected: q.expected, answer: a ? a.answer : null };
});

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : 'n/a');
const types = [...new Set(questions.map(q => q.type))];
const byType = types.map(t => {
  const r = rows.filter(x => x.type === t);
  return { type: t, questions: r.length, passed: r.filter(x => x.pass).length, toolCalls: r.reduce((a, x) => a + x.toolCalls, 0) };
});
const failures = rows.filter(r => !r.pass).reduce((m, r) => ({ ...m, [r.failure]: (m[r.failure] || 0) + 1 }), {});
const summary = {
  scoredAt: new Date().toISOString(),
  questions: rows.length,
  passed: rows.filter(r => r.pass).length,
  passRate: pct(rows.filter(r => r.pass).length, rows.length),
  toolCalls: rows.reduce((a, r) => a + r.toolCalls, 0),
  byType: byType.map(b => ({ ...b, passRate: pct(b.passed, b.questions) })),
  failures
};
fs.writeFileSync(path.join(OUT, 'score.json'), JSON.stringify({ summary, rows }, null, 1) + '\n');

const md = [
  '# Eval score', '',
  `Scored ${summary.scoredAt} from \`answers.jsonl\` (frozen before scoring).`, '',
  `**Overall: ${summary.passed} / ${summary.questions} (${summary.passRate})**, ${summary.toolCalls} tool calls.`, '',
  '| Question type | Questions | Passed | Pass rate | Tool calls |', '|---|---:|---:|---:|---:|',
  ...summary.byType.map(b => `| ${b.type} | ${b.questions} | ${b.passed} | ${b.passRate} | ${b.toolCalls} |`), '',
  '## Failure kinds', '',
  ...(Object.keys(failures).length ? ['| Kind | Count |', '|---|---:|', ...Object.entries(failures).map(([k, v]) => `| ${k} | ${v} |`)] : ['None.']), '',
  '## Per question', '',
  '| Id | Type | Result | Failure | Calls |', '|---|---|---|---|---:|',
  ...rows.map(r => `| ${r.id} | ${r.type} | ${r.pass ? 'pass' : 'FAIL'} | ${r.failure || ''} | ${r.toolCalls} |`), ''
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), md);
console.log(md.split('\n').slice(0, 20).join('\n'));
