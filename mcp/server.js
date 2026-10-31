#!/usr/bin/env node
'use strict';
// Read-only MCP server over the poker club demo data (stdio transport).
//
//   node mcp/server.js                       serve demo/fixtures
//   POKER_DATA_DIR=<dir> node mcp/server.js  serve another fixture export
//   POKER_AS_OF=10/20/2026                   pin "today" (picks the current season)
//
// Every result is returned twice: as structuredContent (validated against the
// tool's output schema) and as JSON text for clients without structured output.
// Errors come back as isError results with { error: { code, message, ... } }.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { loadData } = require('./lib/data');
const { createTools } = require('./lib/tools');
const { TOOLS } = require('./schemas');

const HANDLERS = {
  get_season_standings: 'getSeasonStandings',
  get_player_season_history: 'getPlayerSeasonHistory',
  get_game_seating: 'getGameSeating',
  get_game_structure: 'getGameStructure'
};

function createServer(data = loadData()) {
  const tools = createTools(data);
  const server = new McpServer(
    { name: 'poker-club-data', version: '1.0.0' },
    { instructions: 'Read-only data for a two-venue bar poker league (demo data). Seasons are per venue. Use get_game_structure for rules before reasoning about points or ties. Unknown names, seasons and venues return an error with suggestions: report them, do not substitute.' }
  );
  for (const [name, spec] of Object.entries(TOOLS)) {
    server.registerTool(name, { ...spec, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, async (args) => {
      try {
        const result = tools[HANDLERS[name]](args || {});
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) {
        const body = e && e.code ? e.toJSON() : { error: { code: 'internal', message: String(e && e.message || e) } };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
      }
    });
  }
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  createServer().connect(new StdioServerTransport()).catch((e) => { console.error(e); process.exit(1); });
}
