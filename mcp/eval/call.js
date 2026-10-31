#!/usr/bin/env node
'use strict';
// The agent's only window onto the data during the eval: one MCP tool call
// over stdio, through the real protocol (initialize, tools/call).
//
//   node mcp/eval/call.js --qid q07 get_player_season_history '{"player":"..."}'
//   node mcp/eval/call.js --list                 print tools/list
//
// Every call is appended to eval/results/tool-calls.jsonl with its question id,
// so each frozen answer can be traced to the calls that produced it.

const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const LOG = path.join(__dirname, 'results', 'tool-calls.jsonl');

async function main() {
  const argv = process.argv.slice(2);
  let qid = null;
  const qi = argv.indexOf('--qid');
  if (qi > -1) { qid = argv[qi + 1]; argv.splice(qi, 2); }
  const client = new Client({ name: 'eval-runner', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'server.js')], env: { ...process.env, POKER_AS_OF: process.env.POKER_AS_OF || '10/20/2026' } }));
  try {
    if (argv[0] === '--list') {
      const { tools } = await client.listTools();
      console.log(JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, input: t.inputSchema.properties })), null, 1));
      return;
    }
    const [name, json] = argv;
    if (!name) throw new Error('usage: call.js --qid <id> <tool> <json-args>');
    const args = json ? JSON.parse(json) : {};
    const res = await client.callTool({ name, arguments: args });
    // Input-schema failures are reported by the SDK as plain text, not our JSON.
    const errorBody = (t) => { try { return JSON.parse(t); } catch { return { error: { code: 'invalid_argument', message: t } }; } };
    const payload = res.isError ? errorBody(res.content[0].text) : res.structuredContent;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ qid, tool: name, args, isError: !!res.isError, at: new Date().toISOString() }) + '\n');
    console.log(JSON.stringify(payload));
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
