#!/usr/bin/env node
'use strict';
// The agent's only window onto the data during the eval: one MCP tool call
// over stdio, through the real protocol (initialize, tools/call).
//
//   node mcp/eval/call.js --log heldout/tool-calls.jsonl --qid h07 get_player_season_history '{"player":"..."}'
//   node mcp/eval/call.js --list                 print tools/list
//
// Every call is appended to the log named by --log (required) with a call id, its question id, the arguments AND the full
// response, so each frozen answer can be checked against what the tools said.
// Output: {"call_id": "...", "result": <tool payload or error body>}.

const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');


async function main() {
  const argv = process.argv.slice(2);
  let qid = null;
  const qi = argv.indexOf('--qid');
  if (qi > -1) { qid = argv[qi + 1]; argv.splice(qi, 2); }
  let LOG = null;
  const li = argv.indexOf('--log');
  if (li > -1) { LOG = path.resolve(argv[li + 1]); argv.splice(li, 2); }
  const client = new Client({ name: 'eval-runner', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'server.js')], env: { ...process.env, POKER_AS_OF: process.env.POKER_AS_OF || '10/20/2026' } }));
  try {
    if (argv[0] === '--list') {
      const { tools } = await client.listTools();
      console.log(JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, input: t.inputSchema.properties })), null, 1));
      return;
    }
    const [name, json] = argv;
    if (!name) throw new Error('usage: call.js [--log <file>] --qid <id> <tool> <json-args>');
    if (!LOG) throw new Error('--log <file> is required; frozen run logs are never appended to by default');
    if (!qid) throw new Error('--qid is required so every call is attributed to a question');
    const args = json ? JSON.parse(json) : {};
    const res = await client.callTool({ name, arguments: args });
    // Input-schema failures are reported by the SDK as plain text, not our JSON.
    const errorBody = (t) => { try { return JSON.parse(t); } catch { return { error: { code: 'invalid_argument', message: t } }; } };
    const payload = res.isError ? errorBody(res.content[0].text) : res.structuredContent;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const prior = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
    const callId = `c${String(prior + 1).padStart(4, '0')}`;
    fs.appendFileSync(LOG, JSON.stringify({ call_id: callId, qid, tool: name, args, isError: !!res.isError, response: payload, at: new Date().toISOString() }) + '\n');
    console.log(JSON.stringify({ call_id: callId, result: payload }));
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
