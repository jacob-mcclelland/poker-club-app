'use strict';
// The scorer's comparison rules, on synthetic answers (not the eval key).
const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('../eval/compare');

test('numbers, names, dates and text normalize before comparing', () => {
  assert.equal(compare({ type: 'number' }, 12, 12), null);
  assert.equal(compare({ type: 'number' }, 12, '12'), null);
  assert.equal(compare({ type: 'number' }, 12, 13), 'wrong_value');
  assert.equal(compare({ type: 'number' }, 12, 'twelve'), 'format_error');
  assert.equal(compare({ type: 'name' }, 'Ana Quill', '  ana   QUILL '), null);
  assert.equal(compare({ type: 'name' }, 'Ana Quill', 'Ana Quil'), 'wrong_entity');
  assert.equal(compare({ type: 'date' }, '9/3/2026', '2026-09-03'), null);
  assert.equal(compare({ type: 'date' }, '9/3/2026', '9/4/2026'), 'wrong_value');
  assert.equal(compare({ type: 'text' }, '100/200', '100 / 200'), null);
});

test('name sets ignore order unless ordered', () => {
  assert.equal(compare({ type: 'names', ordered: false }, ['A B', 'C D'], ['c d', 'a b']), null);
  assert.equal(compare({ type: 'names', ordered: false }, ['A B', 'C D'], ['A B']), 'wrong_entity');
  assert.equal(compare({ type: 'names', ordered: true }, ['A B', 'C D'], ['C D', 'A B']), 'wrong_entity');
  assert.equal(compare({ type: 'names' }, ['A B'], 'A B'), 'format_error');
});

test('errors: expected, missing, wrong code, and false errors', () => {
  const E = { type: 'error' };
  assert.equal(compare(E, { error: 'unknown_player' }, { error: 'unknown_player' }), null);
  assert.equal(compare(E, { error: 'unknown_player' }, 'Ana Quill'), 'should_have_errored');
  assert.equal(compare(E, { error: 'unknown_player' }, 0), 'should_have_errored');
  assert.equal(compare(E, { error: 'unknown_player' }, { error: 'unknown_season' }), 'wrong_error_code');
  assert.equal(compare({ type: 'number' }, 0, { error: 'unknown_player' }), 'false_error');
});

test('objects: all fields right, some right (partial), none right', () => {
  const F = { type: 'object', fields: { name: { type: 'name' }, rank: { type: 'number' } } };
  assert.equal(compare(F, { name: 'A B', rank: 3 }, { name: 'a b', rank: 3 }), null);
  assert.equal(compare(F, { name: 'A B', rank: 3 }, { name: 'A B', rank: 4 }), 'partial');
  assert.equal(compare(F, { name: 'A B', rank: 3 }, { name: 'X Y', rank: 4 }), 'wrong_value');
  assert.equal(compare(F, { name: 'A B', rank: 3 }, null), 'format_error');
});

const { checkEvidence } = require('../eval/evidence');
const { gradeAnswer, goldProblems } = require('../eval/heldout-rules');

test('evidence: cited calls must be in the log under the same question', () => {
  const log = [
    { call_id: 'c0001', qid: 'h01', tool: 'get_season_standings', args: { venue: 'Tight End' }, response: { season: { name: 'Fall 2026' } } },
    { call_id: 'c0002', qid: 'h01', tool: 'get_player_season_history', args: { player: 'Ana Quill', season: 'Fall 2026' }, response: {} },
    { call_id: 'c0003', qid: 'h02', tool: 'get_game_seating', args: { venue: 'Tight End', date: '9/1/2026', game: 1 }, response: {} }
  ];
  const q = 'How many games has Ana Quill played at Tight End this season?';
  assert.equal(checkEvidence('h01', q, ['c0001', 'c0002'], log).ok, true);
  assert.equal(checkEvidence('h01', q, [], log).ok, false);
  assert.equal(checkEvidence('h01', q, undefined, log).ok, false);
  assert.equal(checkEvidence('h01', q, ['c0003'], log).ok, false, 'call logged under another question');
  assert.equal(checkEvidence('h01', q, ['c0009'], log).ok, false, 'call never made');
  assert.deepEqual(checkEvidence('h01', q, ['c0001', 'c0002'], log).unsourced, [], 'season came from the first response');
  assert.deepEqual(checkEvidence('h02', 'Who sat at game 1 last week?', ['c0003'], log).unsourced, ['c0003.venue=Tight End', 'c0003.date=9/1/2026']);
  // development-run citations by tool and args
  assert.equal(checkEvidence('h01', q, [{ tool: 'get_season_standings', args: { venue: 'Tight End' } }], log).ok, true);
  assert.equal(checkEvidence('h01', q, [{ tool: 'get_season_standings', args: { venue: 'Wild Corgi' } }], log).ok, false);
});

test('held-out grading: status, codes, candidates and values', () => {
  const ans = { id: 'h01', category: 'x', accept_status: ['answered'], answer_format: { type: 'number' }, expected: 5, derivation: 'd' };
  const err = { id: 'h02', category: 'x', accept_status: ['error', 'cannot_answer'], error_codes: ['unknown_player'], derivation: 'd' };
  const amb = { id: 'h03', category: 'x', accept_status: ['ambiguous'], candidates: ['A B', 'A C'], derivation: 'd' };
  assert.deepEqual([ans, err, amb].map(goldProblems), [[], [], []]);
  assert.ok(goldProblems({ id: 'h04', category: 'x', accept_status: ['ambiguous'], derivation: 'd' }).length);
  assert.equal(gradeAnswer(ans, { status: 'answered', answer: 5 }), null);
  assert.equal(gradeAnswer(ans, { status: 'answered', answer: 6 }), 'wrong_value');
  assert.equal(gradeAnswer(ans, { status: 'error', error_code: 'unknown_player' }), 'false_error');
  assert.equal(gradeAnswer(ans, { status: 'cannot_answer' }), 'false_refusal');
  assert.equal(gradeAnswer(ans, { status: 'maybe' }), 'format_error');
  assert.equal(gradeAnswer(err, { status: 'error', error_code: 'unknown_player' }), null);
  assert.equal(gradeAnswer(err, { status: 'cannot_answer' }), null);
  assert.equal(gradeAnswer(err, { status: 'error', error_code: 'unknown_season' }), 'wrong_error_code');
  assert.equal(gradeAnswer(err, { status: 'answered', answer: 0 }), 'should_have_refused');
  assert.equal(gradeAnswer(err, { status: 'ambiguous', candidates: ['A B', 'A C'] }), 'wrong_status');
  assert.equal(gradeAnswer(amb, { status: 'ambiguous', candidates: ['a c', 'a b'] }), null);
  assert.equal(gradeAnswer(amb, { status: 'ambiguous', candidates: ['A B'] }), 'wrong_entity');
});
