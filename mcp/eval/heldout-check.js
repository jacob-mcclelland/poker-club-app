#!/usr/bin/env node
'use strict';
// Validates heldout/cases.jsonl and heldout/gold.jsonl against the answer
// contract. Prints only counts and problems, never gold content, so the
// builder can run it without seeing the key.
//   node eval/heldout-check.js [dir]

const fs = require('fs');
const path = require('path');
const { goldProblems } = require('./heldout-rules');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'heldout'));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const cases = read('cases.jsonl');
const gold = read('gold.jsonl');
const problems = [];
for (const c of cases) {
  const extra = Object.keys(c).filter(k => !['id', 'question'].includes(k));
  if (extra.length) problems.push(`${c.id}: cases.jsonl may hold only id and question (found ${extra.join(', ')})`);
}
const ids = cases.map(c => c.id);
if (new Set(ids).size !== ids.length) problems.push('duplicate ids in cases.jsonl');
const gids = new Set(gold.map(g => g.id));
for (const id of ids) if (!gids.has(id)) problems.push(`${id}: no gold row`);
for (const g of gold) {
  if (!ids.includes(g.id)) problems.push(`${g.id}: gold row without a case`);
  for (const m of goldProblems(g)) problems.push(`${g.id}: ${m}`);
}
if (cases.length < 30) problems.push(`only ${cases.length} cases; at least 30 required`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`ok: ${cases.length} cases, ${gold.length} gold rows, ${gold.filter(g => g.judge).length} need the grader`);
