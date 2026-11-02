'use strict';
// The held-out answer contract and the deterministic rules that grade it.
// Shared by heldout-check.js (validates gold before the freeze),
// heldout-score.js (the single scoring run) and test/heldout.test.js.

const { compare, normName } = require('./compare');

const STATUSES = ['answered', 'error', 'cannot_answer', 'ambiguous'];
const VALUE_TYPES = ['number', 'name', 'names', 'date', 'text'];

/** Problems with one gold row (empty array when valid). */
function goldProblems(g) {
  const p = [];
  if (!/^h\d{2,3}$/.test(g.id || '')) p.push('id must look like h01');
  if (!g.category || typeof g.category !== 'string') p.push('category missing');
  if (!Array.isArray(g.accept_status) || !g.accept_status.length || g.accept_status.some(s => !STATUSES.includes(s))) p.push(`accept_status must be a non-empty subset of ${STATUSES.join(', ')}`);
  if (typeof g.derivation !== 'string' || !g.derivation) p.push('derivation missing');
  if (g.judge) {
    if (typeof g.rubric !== 'string' || !g.rubric) p.push('judge items need a rubric');
    return p;
  }
  const acc = g.accept_status || [];
  if (acc.includes('answered')) {
    if (!g.answer_format || !VALUE_TYPES.includes(g.answer_format.type)) p.push(`answer_format.type must be one of ${VALUE_TYPES.join(', ')}`);
    if (g.expected === undefined || g.expected === null) p.push('expected missing');
  }
  if (acc.includes('error') && g.error_codes !== undefined && (!Array.isArray(g.error_codes) || !g.error_codes.length)) p.push('error_codes, when given, must be a non-empty array');
  if (acc.includes('ambiguous') && (!Array.isArray(g.candidates) || g.candidates.length < 2)) p.push('ambiguous items need candidates (2 or more names)');
  return p;
}

/** Deterministic grade of one answer against one non-judge gold row. Returns null (pass) or a failure kind. */
function gradeAnswer(g, a) {
  if (!a || !STATUSES.includes(a.status)) return 'format_error';
  if (!g.accept_status.includes(a.status)) {
    if (a.status === 'answered') return 'should_have_refused';
    if (g.accept_status.length === 1 && g.accept_status[0] === 'answered') return a.status === 'error' ? 'false_error' : 'false_refusal';
    return 'wrong_status';
  }
  if (a.status === 'error') return g.error_codes && !g.error_codes.includes(a.error_code) ? 'wrong_error_code' : null;
  if (a.status === 'ambiguous') {
    if (!Array.isArray(a.candidates)) return 'format_error';
    const x = a.candidates.map(normName).sort().join('|'), y = g.candidates.map(normName).sort().join('|');
    return x === y ? null : 'wrong_entity';
  }
  if (a.status === 'cannot_answer') return null;
  return compare(g.answer_format, g.expected, a.answer);
}

module.exports = { STATUSES, VALUE_TYPES, goldProblems, gradeAnswer };
