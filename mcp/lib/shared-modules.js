'use strict';
// The app's seating rules (public/champ-seating.js) and blind structures
// (public/clock-structures.js) are browser ES modules with no imports. They
// are loaded here the same way scripts/championship-seating-test.js does it,
// so the MCP server runs THE implementation the venue pages run, not a copy.

const fs = require('fs');
const path = require('path');

const PUBLIC = path.resolve(__dirname, '..', '..', 'public');

function loadBrowserModule(file, names) {
  const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8')
    .replace(/^export const /mg, 'const ')
    .replace(/^export function /mg, 'function ')
    .replace(/^export async function /mg, 'async function ');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)();
}

const seating = loadBrowserModule('champ-seating.js', ['buildSeating', 'buildChampionshipRanking', 'rankByBounties', 'splitOverrides', 'ROSTER_SIZE', 'CONSOL_SEATS']);
const clock = loadBrowserModule('clock-structures.js', ['STRUCTURES', 'DEFAULT_STRUCTURE_ID']);

module.exports = { seating, clock };
