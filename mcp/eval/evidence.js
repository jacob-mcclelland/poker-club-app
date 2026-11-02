'use strict';
// Tool-call evidence for one answer, checked against the call log rather than
// taken on the answerer's word.
//
// An answer cites calls either by call id (held-out run: "c0007") or by
// {tool, args} (development run, whose log predates call ids). A citation
// counts only if the log holds that call under the same question id.
//
// Unsourced arguments: a string argument (a player, date, season, venue) that
// appears neither in the question nor in an earlier logged response for the
// same question. That is the "q12 used a date it never looked up" pattern.
// It is reported as a flag, not a failure.

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => ((o[key] = x[key]), o), {}) : x));
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

function checkEvidence(qid, question, cited, log) {
  const mine = log.map((row, i) => ({ ...row, _i: i })).filter(r => r.qid === qid);
  const matched = [];
  const bad = [];
  for (const c of Array.isArray(cited) ? cited : []) {
    const hit = typeof c === 'string'
      ? mine.find(r => r.call_id === c)
      : mine.find(r => r.tool === c.tool && canon(r.args) === canon(c.args) && !matched.includes(r));
    if (hit && !matched.includes(hit)) matched.push(hit); else bad.push(c);
  }
  const unsourced = [];
  for (const call of matched) {
    const seen = norm(question) + ' ' + mine.filter(r => r._i < call._i && r.response !== undefined).map(r => norm(JSON.stringify(r.response))).join(' ');
    for (const [k, v] of Object.entries(call.args || {})) {
      if (typeof v !== 'string') continue;
      const n = norm(v);
      const alt = n.replace(/^0+(\d)/, '$1').replace(/\/0+(\d)/g, '/$1');
      if (!seen.includes(n) && !seen.includes(alt)) unsourced.push(`${call.call_id || call.tool}.${k}=${v}`);
    }
  }
  return { ok: matched.length > 0 && bad.length === 0, matched: matched.map(r => r.call_id || r.tool), invalid: bad, unsourced };
}

module.exports = { checkEvidence, canon };
