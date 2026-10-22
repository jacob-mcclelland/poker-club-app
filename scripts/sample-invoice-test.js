const assert = require('assert');
const {
  SAMPLE_VENUES,
  RATE_CENTS,
  REAL_VENUES,
  buildSampleCheckins,
  invoiceFor,
  renderHtml
} = require('../demo/sample-invoice');

let failures = 0, total = 0;
function check(name, fn) {
  total++;
  try {
    assert.strictEqual(fn(), true);
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}${err && err.message ? ` -> ${err.message}` : ''}`);
  }
}
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };
const PERIOD = { periodStart: '2026-09-01', periodEnd: '2026-09-30', rateCents: RATE_CENTS };
const checkins = buildSampleCheckins();
const secondBuild = buildSampleCheckins();
const invoices = SAMPLE_VENUES.map(v => invoiceFor(checkins, { ...PERIOD, venue: v.name }));

check('the two sample venues are Monday and Wednesday venues', () =>
  SAMPLE_VENUES.length === 2
  && SAMPLE_VENUES[0].name === 'Quillfeather Lounge' && SAMPLE_VENUES[0].weekday === 1
  && SAMPLE_VENUES[1].name === 'Vossington Tap Room' && SAMPLE_VENUES[1].weekday === 3);

check('game 1 and game 2 attendee counts stay in their requested ranges', () => {
  return SAMPLE_VENUES.every(venue => {
    const rows = checkins.filter(row => row.venue === venue.name && row.status === 'active');
    const dates = [...new Set(rows.map(row => row.date))];
    return dates.filter(date => {
      const [month, day, year] = date.split('/').map(Number);
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return iso >= PERIOD.periodStart && iso <= PERIOD.periodEnd;
    }).every(date => {
      const gameOne = rows.filter(row => row.date === date && row.gameNum === 1).length;
      const gameTwo = rows.filter(row => row.date === date && row.gameNum === 2).length;
      return gameOne >= 18 && gameOne <= 34 && gameTwo >= 12 && gameTwo <= 26;
    });
  });
});

check('game 2 mostly overlaps game 1', () => {
  const date = checkins.find(row => row.venue === SAMPLE_VENUES[0].name).date;
  const firstRows = checkins.filter(row => row.venue === SAMPLE_VENUES[0].name && row.date === date && row.status === 'active');
  const first = new Set(firstRows.filter(row => row.gameNum === 1).map(row => row.playerLower));
  const second = firstRows.filter(row => row.gameNum === 2);
  const overlap = second.filter(row => first.has(row.playerLower)).length;
  return overlap / second.length >= 0.75;
});

check('a night line counts distinct people across both games', () => {
  const venue = SAMPLE_VENUES[0].name;
  const date = checkins.find(row => row.venue === venue).date;
  const key = `${Number(date.split('/')[2])}-${String(Number(date.split('/')[0])).padStart(2, '0')}-${String(Number(date.split('/')[1])).padStart(2, '0')}`;
  const expected = new Set(checkins
    .filter(row => row.venue === venue && row.date === date && row.status !== 'removed')
    .map(row => row.playerLower || row.player.trim().toLowerCase())).size;
  const line = invoices[0].lines.find(row => row.date === key);
  return line && line.people === expected;
});

check('a repeat entry in different letter case is billed once', () => {
  const duplicates = checkins.filter(row => row.venue === SAMPLE_VENUES[0].name && row.status === 'active');
  const pair = duplicates.find((row, index) => duplicates.some((other, i) => i !== index
    && other.date === row.date && other.playerLower === row.playerLower && other.player !== row.player));
  if (!pair) return false;
  const counterpart = duplicates.find(row => row !== pair && row.date === pair.date
    && row.playerLower === pair.playerLower && row.player !== pair.player);
  const pairRows = [pair, counterpart];
  const pairInvoice = invoiceFor(pairRows, { ...PERIOD, venue: SAMPLE_VENUES[0].name });
  return pairInvoice.notBilled.sameNightRepeats === 1 && pairInvoice.totalPeople === 1;
});

check('removed check-ins are not billed', () => invoices[0].notBilled.removed === 1);

check('the other venue does not appear on this venue invoice', () => {
  const otherVenueRow = checkins.find(row => row.venue === SAMPLE_VENUES[1].name && row.date === '9/2/2026');
  return !!otherVenueRow && !invoices[0].lines.some(line => line.date === '2026-09-02');
});

check('outside-period check-ins are not billed', () =>
  invoices[0].notBilled.outsidePeriod === 1 && !invoices[0].lines.some(line => line.date === '2026-10-05'));

check('all invoice totals use integer cents at the demo rate', () => invoices.every(invoice =>
  invoice.totalCents === invoice.totalPeople * 600
  && invoice.totalCents === invoice.lines.reduce((sum, line) => sum + line.amountCents, 0)
  && invoice.lines.every(line => line.amountCents === line.people * 600)));

check('each real venue is refused, including mixed case and extra spaces', () =>
  REAL_VENUES.every(venue => throws(() => invoiceFor(checkins, { ...PERIOD, venue })))
  && throws(() => invoiceFor(checkins, { ...PERIOD, venue: ' tight  END ' })));

check('two builds produce identical check-ins, invoices, and HTML', () => {
  const secondInvoices = SAMPLE_VENUES.map(v => invoiceFor(secondBuild, { ...PERIOD, venue: v.name }));
  return JSON.stringify(checkins) === JSON.stringify(secondBuild)
    && JSON.stringify(invoices) === JSON.stringify(secondInvoices)
    && invoices.every((invoice, i) => renderHtml(invoice) === renderHtml(secondInvoices[i]));
});

check('HTML contains the sample banner and excludes both real venue names', () => invoices.every(invoice => {
  const html = renderHtml(invoice).toLowerCase();
  return html.includes('sample data: not a real invoice')
    && html.includes('$6.00 per person per game night (demo rate)')
    && REAL_VENUES.every(venue => !html.includes(venue.toLowerCase()));
}));

if (failures) {
  console.log(`FAIL ${failures} of ${total} cases`);
  process.exit(1);
} else {
  console.log(`PASS all ${total} cases`);
}
