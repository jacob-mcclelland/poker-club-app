'use strict';
// Answer comparison for eval/score.js, kept separate so it can be tested
// (test/score.test.js) before the one real scoring run.

const normName = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
const normText = (s) => String(s).trim().replace(/\s+/g, '').toLowerCase();
const normDate = (s) => {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${+m[2]}/${+m[3]}/${m[1]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${+m[1]}/${+m[2]}/${m[3]}` : null;
};

/** Compare one value to its expected value under a format. Returns null when correct, else a failure kind. */
function compare(fmt, expected, got) {
  if (got === undefined || got === null) return 'format_error';
  if (got && typeof got === 'object' && !Array.isArray(got) && 'error' in got && fmt.type !== 'error') return 'false_error';
  switch (fmt.type) {
    case 'number': return typeof got === 'number' || /^-?\d+(\.\d+)?$/.test(String(got)) ? (Number(got) === expected ? null : 'wrong_value') : 'format_error';
    case 'name': return typeof got === 'string' ? (normName(got) === normName(expected) ? null : 'wrong_entity') : 'format_error';
    case 'names': {
      if (!Array.isArray(got)) return 'format_error';
      const a = got.map(normName), b = expected.map(normName);
      const same = fmt.ordered ? a.join('|') === b.join('|') : a.slice().sort().join('|') === b.slice().sort().join('|');
      return same ? null : 'wrong_entity';
    }
    case 'date': return normDate(got) ? (normDate(got) === normDate(expected) ? null : 'wrong_value') : 'format_error';
    case 'text': return typeof got === 'string' ? (normText(got) === normText(expected) ? null : 'wrong_value') : 'format_error';
    case 'error': {
      if (!got || typeof got !== 'object' || !('error' in got)) return 'should_have_errored';
      return got.error === expected.error ? null : 'wrong_error_code';
    }
    case 'object': {
      if (!got || typeof got !== 'object' || Array.isArray(got)) return 'format_error';
      const misses = Object.entries(fmt.fields).map(([k, f]) => compare(f, expected[k], got[k])).filter(Boolean);
      if (!misses.length) return null;
      return misses.length === Object.keys(fmt.fields).length ? (misses.every(m => m === misses[0]) ? misses[0] : 'wrong_value') : 'partial';
    }
    default: throw new Error(`unknown answer format ${fmt.type}`);
  }
}

module.exports = { compare, normName, normDate };
