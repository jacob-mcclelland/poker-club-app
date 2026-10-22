// Display helpers shared by the phone pages (clock.html, staff/clock-control.html).
// They read the same blind structure the TV publishes to timerClocks/{venue}
// and label it the way staff/timer.html does (updateBlindsDisplay), so a
// phone never disagrees with the TV. Pure: no imports, no DOM.

export const VENUES = {
  tight: { name: 'Tight End', apiVenue: 'Tight End' },
  corgi: { name: 'Wild Corgi', apiVenue: 'Wild Corgi' }
};

export function venueFromUrl() {
  const v = new URLSearchParams(location.search).get('venue');
  return VENUES[v] ? v : 'tight';
}

// Clock ids: 'tight' and 'corgi' for the venues, or a generated id for a
// named clock (a home game): lowercase letters, digits and dashes, 3 to 40
// characters, matching firestore.rules timerClocks. ?clock= wins over ?venue=.
export const CLOCK_ID_PATTERN = /^[a-z0-9-]{3,40}$/;

export function clockIdFromUrl() {
  const c = new URLSearchParams(location.search).get('clock');
  if (c && CLOCK_ID_PATTERN.test(c)) return c;
  return venueFromUrl();
}

export function isVenueClock(id) {
  return !!VENUES[id];
}

// Display name: the venue's name, else the name stored on the clock.
export function clockName(id, data) {
  if (VENUES[id]) return VENUES[id].name;
  return (data && typeof data.name === 'string' && data.name.trim()) ? data.name.trim().slice(0, 40) : 'Poker clock';
}

// A new id from a name: "Sam's house" -> "sams-house-k3x9q2". The caller
// checks the id is unused before creating it (clock-control.html).
export function newClockId(name) {
  const slug = String(name || 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'game';
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${slug}-${rand}`;
}

// Whole seconds, rounded up, as M:SS (the TV shows 12:00 for the first second).
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Same rule as the TV's formatBlinds: K only once the small blind reaches
// 1000, applied to both (500 / 1000, then 1K / 2K).
function formatPair(small, big) {
  return small >= 1000 ? `${small / 1000}K / ${big / 1000}K` : `${small} / ${big}`;
}

// "R3", "Break & Chip Up", "Draw for Seats"
export function levelLabel(level) {
  if (!level) return '';
  if (level.isPreGame || typeof level.level === 'string') return level.name;
  return `R${level.level}`;
}

// What goes in the blinds line. kind: 'blinds' | 'break' | 'pregame'.
//   blinds:  { main: '100 / 200' } or, from Round 8 on, { main: '1 / 2', sub: 'chips (5K each)' }
//   break:   { main: 'Break & Chip Up', sub: 'Red, White & Blue into stacks of 500' }
//   pregame: { main: 'Draw for Seats' }
export function blindsLine(level) {
  if (!level) return { kind: 'pregame', main: '' };
  if (level.isBreak) return { kind: 'break', main: level.name, sub: level.chipUp || '' };
  if (level.isPreGame) return { kind: 'pregame', main: level.name };
  if (level.displayChips) {
    const [small, big] = level.displayChips.split('/');
    return { kind: 'blinds', main: `${small} / ${big}`, sub: 'chips (5K each)' };
  }
  let main = formatPair(level.small, level.big);
  if (level.ante) main += ` · ante ${level.ante >= 1000 ? `${level.ante / 1000}K` : level.ante}`;
  return { kind: 'blinds', main };
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
