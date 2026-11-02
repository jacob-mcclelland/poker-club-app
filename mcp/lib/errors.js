'use strict';
// One error shape for every tool. `code` is stable and machine-readable;
// `message` is for the agent to read; `details` carries suggestions.
//
// Codes: invalid_argument, invalid_date, unknown_venue, unknown_season,
// unknown_player, ambiguous_player, no_game, game_not_played.

class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
  toJSON() { return { error: { code: this.code, message: this.message, ...this.details } }; }
}

module.exports = { ToolError };
