// Selects this device's most recent sent shot card for receipt reopening.
// Used by public/shots.html after the live shot card feed arrives.
// Test: node scripts/shots-reopen-test.js

export const REOPEN_MS = 30 * 60 * 1000;

export function pickReopenCard({
  lastSent,
  cards,
  sessionDate,
  venue,
  clientId,
  now,
  forceNew,
  draftResumed,
  datesMatch = (a, b) => a === b
} = {}) {
  if (forceNew || draftResumed) return null;
  if (!lastSent || !lastSent.id) return null;

  const age = now - lastSent.sentAt;
  if (!Number.isFinite(age) || age < 0 || age > REOPEN_MS) return null;
  if (!datesMatch(lastSent.sessionDate, sessionDate)) return null;
  if (lastSent.venue && venue && lastSent.venue !== venue) return null;

  const card = (cards || []).find(candidate => candidate && candidate.id === lastSent.id);
  if (!card || card.clientId !== clientId) return null;
  return card;
}
