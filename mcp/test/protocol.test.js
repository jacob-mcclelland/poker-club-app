'use strict';
// End-to-end over the MCP protocol: spawn server.js on stdio, list tools,
// call each one, and check results and errors come back in the documented shape.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('MCP stdio: tools/list and tools/call', async (t) => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'server.js')], env: { ...process.env, POKER_AS_OF: '10/20/2026' } }));
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), ['get_game_seating', 'get_game_structure', 'get_player_season_history', 'get_season_standings']);
  for (const tool of tools) {
    assert.ok(tool.description.length > 80, `${tool.name} is documented`);
    assert.equal(tool.outputSchema.type, 'object', `${tool.name} has an output schema`);
    assert.equal(tool.annotations.readOnlyHint, true);
  }

  const ok = await client.callTool({ name: 'get_season_standings', arguments: { venue: 'Wild Corgi', limit: 1 } });
  assert.ok(!ok.isError);
  assert.equal(ok.structuredContent.standings.length, 1);
  assert.deepEqual(JSON.parse(ok.content[0].text), ok.structuredContent);

  const seat = await client.callTool({ name: 'get_game_seating', arguments: { venue: 'Wild Corgi', date: '8/13/2026', game: 1 } });
  assert.equal(seat.structuredContent.kind, 'championship');
  const hist = await client.callTool({ name: 'get_player_season_history', arguments: { player: 'Yaely' } });
  assert.equal(hist.structuredContent.player.matchedBy, 'alias');
  const st = await client.callTool({ name: 'get_game_structure', arguments: {} });
  assert.equal(st.structuredContent.blindStructure.id, 'standard');

  const bad = await client.callTool({ name: 'get_player_season_history', arguments: { player: 'Morgan Quillsby' } });
  assert.equal(bad.isError, true);
  assert.equal(JSON.parse(bad.content[0].text).error.code, 'unknown_player');
});
