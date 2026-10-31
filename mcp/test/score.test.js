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
