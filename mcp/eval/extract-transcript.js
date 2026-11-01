#!/usr/bin/env node
'use strict';
// Turns a subagent's raw session log into a reviewable transcript: the first
// prompt, the agent's text, each tool call's input, and each tool result
// (cut at 4,000 characters). Harness reminders and metadata are dropped; the
// session scratch path is shortened to <scratch>.
//   node eval/extract-transcript.js <raw.jsonl> <out.jsonl>
const fs = require('fs');
const [src, out] = process.argv.slice(2);
const SCRATCH = /\/tmp\/claude-0\/[^\s"'\\]*?\/scratchpad/g;
const clean = (s) => String(s).replace(SCRATCH, '<scratch>').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
const rows = [];
let first = true;
for (const line of fs.readFileSync(src, 'utf8').trim().split('\n')) {
  const e = JSON.parse(line);
  if (!e.message || !['user', 'assistant'].includes(e.type)) continue;
  const content = typeof e.message.content === 'string' ? [{ type: 'text', text: e.message.content }] : e.message.content;
  for (const c of content) {
    if (e.type === 'user' && c.type === 'text') {
      const t = clean(c.text);
      if (first && t) { rows.push({ at: e.timestamp, kind: 'prompt', text: t }); first = false; }
    } else if (c.type === 'text' && clean(c.text)) rows.push({ at: e.timestamp, kind: 'agent_text', text: clean(c.text) });
    else if (c.type === 'tool_use') rows.push({ at: e.timestamp, kind: 'tool_call', id: c.id, tool: c.name, input: JSON.parse(clean(JSON.stringify(c.input))) });
    else if (c.type === 'tool_result') {
      const t = clean(Array.isArray(c.content) ? c.content.map(x => x.text || '').join('\n') : c.content || '');
      rows.push({ at: e.timestamp, kind: 'tool_result', id: c.tool_use_id, text: t.length > 4000 ? t.slice(0, 4000) + ' [cut]' : t });
    }
  }
}
fs.writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`${rows.length} rows -> ${out}`);
