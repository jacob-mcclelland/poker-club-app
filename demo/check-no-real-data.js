#!/usr/bin/env node
// Guard for the showcase copy: fails if anything that looks like real club data
// or a private identifier is in the tree. Prints counts and file:line only, never
// the matched value.
//
//   node demo/check-no-real-data.js
//
// 1. The fixtures are exactly what demo/seed.js generates (nobody pasted rows in).
// 2. Every generated name uses an invented surname, or is one of the messy rows.
// 3. No file holds a real-looking email, phone number, API key, project id,
//    hosted URL or local path.

'use strict';
const fs = require('fs');
const path = require('path');
const { sortKeys, LAST } = require('./seed');
const { RATE_CENTS, REAL_VENUES, renderAll, seedBuild } = require('./sample-invoice');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.firebase']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|mp3|wav|woff2?|ttf|pdf|zip)$/i;
let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`); };
const pass = (msg) => console.log(`ok    ${msg}`);

// 1. fixtures match a fresh build
const { out } = seedBuild;
const fixDir = path.join(__dirname, 'fixtures');
const onDisk = fs.existsSync(fixDir) ? fs.readdirSync(fixDir).filter(f => f.endsWith('.json')).sort() : [];
const expected = Object.keys(out).map(c => `${c}.json`).sort();
if (onDisk.join() !== expected.join()) fail(`demo/fixtures holds ${onDisk.length} files, the generator makes ${expected.length}`);
let stale = 0;
for (const c of Object.keys(out)) {
  const file = path.join(fixDir, `${c}.json`);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== JSON.stringify(sortKeys(out[c]), null, 1) + '\n') stale++;
}
stale ? fail(`${stale} fixture file(s) differ from a fresh run of demo/seed.js`) : pass('fixtures are byte-identical to a fresh run of demo/seed.js');

// 2. sample invoice artifacts match a fresh render
const invoiceDir = path.join(__dirname, 'invoices');
const invoiceFiles = fs.existsSync(invoiceDir) ? fs.readdirSync(invoiceDir).sort() : [];
const invoiceExpected = renderAll();
let invoiceStale = invoiceFiles.length === invoiceExpected.size ? 0 : 1;
for (const [name, expectedBytes] of invoiceExpected) {
  const file = path.join(invoiceDir, name);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expectedBytes) invoiceStale++;
}
invoiceStale ? fail(`${invoiceStale} invoice file(s) differ from a fresh render`) : pass('invoice files are byte-identical to a fresh render');

// 3. invoice artifacts contain no real venue names
let realVenueHits = 0;
for (const file of invoiceFiles) {
  const full = path.join(invoiceDir, file);
  if (!fs.statSync(full).isFile()) continue;
  const text = fs.readFileSync(full, 'utf8').toLowerCase();
  if (REAL_VENUES.some(venue => text.includes(venue.toLowerCase()))) realVenueHits++;
}
realVenueHits ? fail(`${realVenueHits} invoice file(s) mention a real venue`) : pass('invoice files contain no real venue names');

// 4. every invoice JSON is sample data at the configured demo rate
let badInvoiceJson = 0;
for (const file of invoiceFiles.filter(name => name.endsWith('.json'))) {
  try {
    const invoice = JSON.parse(fs.readFileSync(path.join(invoiceDir, file), 'utf8'));
    if (invoice.sample !== true || invoice.ratePerPersonCents !== RATE_CENTS) badInvoiceJson++;
  } catch (err) {
    badInvoiceJson++;
  }
}
badInvoiceJson ? fail(`${badInvoiceJson} invoice JSON file(s) have an invalid sample marker or rate`) : pass('every invoice JSON is sample data at the configured demo rate');

// 5. name shapes
const invented = new Set(LAST.map(s => s.toLowerCase()));
const MESSY_OK = /^(test|asdf|[a-z]+( [a-z])?)$/i; // junk rows, first name only, one-letter surname
const typoOf = (s) => [...invented].some(x => x.length === s.length + 1 && x.startsWith(s));
let odd = 0;
for (const p of Object.values(out.players)) {
  const name = p.name.trim();
  const parts = name.split(/\s+/);
  const surname = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
  if (!(invented.has(surname) || (surname && typoOf(surname)) || MESSY_OK.test(name))) odd++;
}
odd ? fail(`${odd} generated player name(s) do not use an invented surname`) : pass(`all ${Object.keys(out.players).length} generated player names use invented surnames or are messy rows`);

// 6. markers across the tree
const MARKERS = {
  'email outside example domains': /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)(?![A-Za-z0-9.-]*\.(test|example)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  'phone number outside 555': /\(?\b(?!555)\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g,
  'Google API key': /AIza[0-9A-Za-z_\-]{35}/g,
  'Firebase project id other than demo-poker': /projects\/(?!demo-poker\b|demo-poker-test\b|\$\{)[a-z0-9-]{6,}/g,
  'hosted app URL': /(?<![a-z0-9-])(?!demo-poker\.)[a-z0-9-]+\.(web\.app|firebaseapp\.com)\b/gi,
  'local user path': /c:[\\/]+users[\\/]/gi
};
const counts = Object.fromEntries(Object.keys(MARKERS).map(k => [k, []]));
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(full); continue; }
    if (BINARY.test(ent.name)) continue;
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (rel === 'demo/check-no-real-data.js') continue; // holds the patterns themselves
    fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const [name, rx] of Object.entries(MARKERS)) {
        rx.lastIndex = 0;
        if (rx.test(line)) counts[name].push(`${rel}:${i + 1}`);
      }
    });
  }
}
walk(ROOT);
for (const [name, where] of Object.entries(counts)) {
  if (where.length) fail(`${name}: ${where.length} line(s): ${where.slice(0, 10).join(', ')}${where.length > 10 ? ', ...' : ''}`);
  else pass(`no ${name}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
