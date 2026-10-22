#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { build, sortKeys } = require('./seed');

const SAMPLE_VENUES = Object.freeze([
  Object.freeze({ name: 'Quillfeather Lounge', weekday: 1 }),
  Object.freeze({ name: 'Vossington Tap Room', weekday: 3 })
]);
const RATE_CENTS = 600;
const REAL_VENUES = Object.freeze(['Tight End', 'Wild Corgi']);
const PERIOD_START = '2026-09-01';
const PERIOD_END = '2026-09-30';
const SEED_BUILD = build();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function normalizeVenue(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function isoDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseMdy(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return isoDate(date);
}

function parseIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return isoDate(date) === value ? date : null;
}

function venueCode(venue) {
  return venue.split(/\s+/).map(part => part[0]).join('').toUpperCase();
}

function buildSampleCheckins() {
  const rand = mulberry32(20260901);
  const between = (low, high) => low + Math.floor(rand() * (high - low + 1));
  const playersById = new Map();
  for (const player of Object.values(SEED_BUILD.out.players)) {
    if (!player || typeof player.name !== 'string' || !player.name.trim().includes(' ')) continue;
    const playerLower = normalizeName(player.nameLower || player.name);
    if (!playerLower || playersById.has(playerLower)) continue;
    playersById.set(playerLower, { name: player.name.trim(), playerLower });
  }
  const roster = [...playersById.values()];
  if (roster.length < 60) throw new Error('The generated roster is too small for the sample check-ins.');

  const checkins = [];
  const events = [];
  const start = parseIso(PERIOD_START);
  const end = parseIso(PERIOD_END);
  for (const venue of SAMPLE_VENUES) {
    for (let date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      if (date.getUTCDay() !== venue.weekday) continue;
      events.push({ venue, date: new Date(date) });
    }
  }
  events.sort((a, b) => isoDate(a.date).localeCompare(isoDate(b.date)) || a.venue.name.localeCompare(b.venue.name));
  const duplicateDate = events.find(event => event.venue.name === SAMPLE_VENUES[0].name).date;

  function drawPlayers(pool, count) {
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, count);
  }

  function addCheckin(player, event, gameNum, status = 'active') {
    const date = isoDate(event.date);
    const [year, month, day] = date.split('-').map(Number);
    const hour = gameNum === 1 ? 18 : 21;
    checkins.push({
      player: player.name,
      playerLower: player.playerLower,
      date: `${month}/${day}/${year}`,
      gameNum,
      venue: event.venue.name,
      gameType: 'Regular',
      status,
      createdAt: new Date(Date.UTC(year, month - 1, day, hour)).toISOString()
    });
  }

  for (const event of events) {
    const gameOneCount = between(18, 34);
    const gameOne = drawPlayers(roster, gameOneCount);
    for (const player of gameOne) addCheckin(player, event, 1);

    const isDuplicateNight = event.venue.name === SAMPLE_VENUES[0].name && isoDate(event.date) === isoDate(duplicateDate);
    const gameTwoCount = between(12, isDuplicateNight ? 24 : 26);
    const overlapCount = Math.min(gameTwoCount, Math.max(1, Math.floor(gameTwoCount * 0.8)));
    const overlap = drawPlayers(gameOne, overlapCount);
    const gameOneIds = new Set(gameOne.map(player => player.playerLower));
    const newcomers = drawPlayers(roster.filter(player => !gameOneIds.has(player.playerLower)), gameTwoCount - overlapCount);
    const gameTwo = [...overlap, ...newcomers];
    for (const player of gameTwo) addCheckin(player, event, 2);

    if (isDuplicateNight) {
      const repeated = gameTwo[0];
      addCheckin({ name: repeated.name.toUpperCase(), playerLower: repeated.playerLower }, event, 2);
      const attendeeIds = new Set([...gameOne, ...gameTwo].map(player => player.playerLower));
      const removed = roster.find(player => !attendeeIds.has(player.playerLower));
      addCheckin(removed, event, 2, 'removed');
    }
  }

  const outOfPeriod = { venue: SAMPLE_VENUES[0], date: new Date(Date.UTC(2026, 9, 5)) };
  const usedOnOutOfPeriod = new Set(checkins.filter(c => c.venue === outOfPeriod.venue.name).map(c => c.playerLower));
  const outsidePlayer = roster.find(player => !usedOnOutOfPeriod.has(player.playerLower));
  addCheckin(outsidePlayer, outOfPeriod, 1);
  return checkins;
}

function invoiceFor(checkins, { venue, periodStart, periodEnd, rateCents }) {
  const normalizedVenue = normalizeVenue(venue);
  if (REAL_VENUES.some(real => normalizeVenue(real) === normalizedVenue)) {
    throw new Error('Invoices cannot be created for real club venues.');
  }
  const sampleVenue = SAMPLE_VENUES.find(item => normalizeVenue(item.name) === normalizedVenue);
  if (!sampleVenue) throw new Error('Unknown sample venue.');
  if (!Array.isArray(checkins)) throw new TypeError('Check-ins must be an array.');
  if (!parseIso(periodStart) || !parseIso(periodEnd) || periodStart > periodEnd) throw new TypeError('Invoice period must be a valid date range.');
  if (rateCents !== RATE_CENTS) throw new TypeError('The sample invoice rate must use the configured demo rate.');

  const lower = new Map();
  let sameNightRepeats = 0; // a second game, or a repeat entry, by someone already counted that night
  let removed = 0;
  let outsidePeriod = 0;
  for (const checkin of checkins) {
    if (!checkin || normalizeVenue(checkin.venue) !== normalizeVenue(sampleVenue.name)) continue;
    if (String(checkin.status || '').trim().toLowerCase() === 'removed') {
      removed++;
      continue;
    }
    const date = parseMdy(checkin.date);
    if (!date || date < periodStart || date > periodEnd) {
      outsidePeriod++;
      continue;
    }
    const playerKey = normalizeName(checkin.playerLower) || normalizeName(checkin.player);
    if (!playerKey) continue;
    if (!lower.has(date)) lower.set(date, new Set());
    const people = lower.get(date);
    if (people.has(playerKey)) sameNightRepeats++;
    else people.add(playerKey);
  }

  const lines = [...lower.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, people]) => ({
    date,
    people: people.size,
    amountCents: people.size * rateCents
  }));
  const totalPeople = lines.reduce((sum, line) => sum + line.people, 0);
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    sample: true,
    invoiceNumber: `SAMPLE-${periodStart.slice(0, 7)}-${venueCode(sampleVenue.name)}`,
    venue: sampleVenue.name,
    periodStart,
    periodEnd,
    ratePerPersonCents: rateCents,
    lines,
    totalPeople,
    totalCents,
    notBilled: { sameNightRepeats, removed, outsidePeriod }
  };
}

function formatMoney(cents) {
  const whole = Math.floor(cents / 100).toLocaleString('en-US');
  const fraction = String(cents % 100).padStart(2, '0');
  return `$${whole}.${fraction}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function renderHtml(invoice) {
  const rows = invoice.lines.map(line => `      <tr><td>${escapeHtml(line.date)}</td><td class="num">${line.people}</td><td class="num">${formatMoney(line.amountCents)}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sample invoice for ${escapeHtml(invoice.venue)}</title>
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; color: #202938; background: #f3f5f8; }
    body { margin: 0; padding: 32px 16px; }
    main { max-width: 760px; margin: 0 auto; padding: 32px; background: #fff; border: 1px solid #d9dee7; border-radius: 12px; }
    .banner { margin: -32px -32px 28px; padding: 16px 24px; border-radius: 12px 12px 0 0; background: #7b1e2b; color: #fff; font-size: 20px; font-weight: 700; text-align: center; }
    h1 { margin: 0 0 24px; font-size: 28px; }
    .parties { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
    .label { color: #5d6878; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .value { margin-top: 6px; font-size: 16px; }
    .meta { margin: 0 0 20px; color: #5d6878; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 10px; border-bottom: 1px solid #e2e6ed; text-align: left; }
    th { background: #f6f7f9; font-size: 12px; text-transform: uppercase; }
    .num { text-align: right; }
    .rate { margin: 18px 0; color: #4e5a6b; }
    .total { display: flex; justify-content: space-between; padding-top: 16px; border-top: 2px solid #202938; font-size: 22px; font-weight: 700; }
    @media print { :root { background: #fff; } body { padding: 0; } main { max-width: none; border: 0; border-radius: 0; } }
  </style>
</head>
<body>
  <main>
    <div class="banner">SAMPLE DATA: not a real invoice</div>
    <h1>Invoice</h1>
    <div class="parties">
      <div><div class="label">From</div><div class="value">All-In Poker Club (sample)</div></div>
      <div><div class="label">Bill to</div><div class="value">${escapeHtml(invoice.venue)}</div></div>
    </div>
    <p class="meta">${escapeHtml(invoice.invoiceNumber)} | ${escapeHtml(invoice.periodStart)} to ${escapeHtml(invoice.periodEnd)}</p>
    <table>
      <thead><tr><th>Date</th><th class="num">People</th><th class="num">Amount</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <p class="rate">${formatMoney(invoice.ratePerPersonCents)} per person per game night (demo rate)</p>
    <div class="total"><span>Total</span><span>${formatMoney(invoice.totalCents)}</span></div>
  </main>
</body>
</html>
`;
}

function slug(venue) {
  return venue.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Every file under demo/invoices, as file name -> exact contents.
function renderAll() {
  const checkins = buildSampleCheckins();
  const files = new Map();
  for (const venue of SAMPLE_VENUES) {
    const invoice = invoiceFor(checkins, {
      venue: venue.name,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rateCents: RATE_CENTS
    });
    files.set(`${slug(venue.name)}.json`, JSON.stringify(sortKeys(invoice), null, 1) + '\n');
    files.set(`${slug(venue.name)}.html`, renderHtml(invoice));
  }
  return files;
}

function writeInvoices() {
  const outputDir = path.join(__dirname, 'invoices');
  fs.mkdirSync(outputDir, { recursive: true });
  for (const [name, contents] of renderAll()) {
    fs.writeFileSync(path.join(outputDir, name), contents);
    if (name.endsWith('.json')) {
      const invoice = JSON.parse(contents);
      console.log(`${invoice.venue}: ${invoice.totalPeople} people, ${formatMoney(invoice.totalCents)}`);
    }
  }
}

module.exports = {
  SAMPLE_VENUES,
  RATE_CENTS,
  REAL_VENUES,
  buildSampleCheckins,
  invoiceFor,
  renderHtml,
  renderAll,
  seedBuild: SEED_BUILD
};

if (require.main === module) writeInvoices();
