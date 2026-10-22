// Player app: a round timer button in the bottom-left corner while a venue
// clock is running tonight. Shows the time left while the clock runs; tapping
// opens the full-screen player clock (clock.html). Bottom-right belongs to the
// notification / shots button and the contest button. One script tag in
// index.html. Design: docs/timer-prd/07-synced-clock.md.
import { db, doc, onSnapshot } from './firebase-api.js?v=13';
import { pickFrom } from './clock-pick.js?v=2';
import { serverNow, measureServerOffset } from './clock-sync.js?v=3';
import { formatClock } from './clock-view.js?v=2';

const VENUES = ['tight', 'corgi'];
const docs = {};
let button = null;

function makeButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'clockFab';
  b.setAttribute('aria-label', 'Open the tournament clock');
  b.title = 'Tournament clock';
  const big = document.documentElement.classList.contains('large-text');
  Object.assign(b.style, {
    position: 'fixed', left: '16px', bottom: '20px', zIndex: '200',
    width: big ? '60px' : '48px', height: big ? '60px' : '48px', borderRadius: '50%',
    background: '#1a1a1a', border: '1px solid rgba(212,175,55,0.5)', color: '#e8e8e8',
    boxShadow: '0 2px 12px rgba(0,0,0,0.5)', cursor: 'pointer', padding: '0',
    display: 'none', alignItems: 'center', justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontWeight: '800', fontVariantNumeric: 'tabular-nums', lineHeight: '1'
  });
  // Opens the same game whose time the button shows.
  b.addEventListener('click', () => {
    const target = b.dataset.venue;
    if (target) location.href = `/clock?venue=${encodeURIComponent(target)}&game=${b.dataset.game || '1'}&from=app`;
  });
  document.body.appendChild(b);
  return b;
}

function pickGame() {
  return pickFrom(docs, serverNow());
}

function render() {
  const pick = pickGame();
  if (!pick) {
    if (button) button.style.display = 'none';
    return;
  }
  if (!button) button = makeButton();
  button.dataset.venue = pick.venue;
  button.dataset.game = pick.game;
  const running = pick.view.phase === 'running';
  const text = running ? formatClock(pick.view.remainingMs) : '⏱';
  if (button.textContent !== text) button.textContent = text;
  button.style.fontSize = running ? (text.length > 4 ? '0.78rem' : '0.9rem') : '1.4rem';
  button.style.color = running && pick.view.remainingMs <= 60000 ? '#ff5a4a' : '#e8e8e8';
  button.style.display = 'flex';
}

measureServerOffset();
for (const venue of VENUES) {
  onSnapshot(doc(db, 'timerClocks', venue), (snap) => {
    docs[venue] = snap.exists() ? snap.data() : null;
    render();
  }, (err) => console.warn('Clock button unavailable:', err));
}
setInterval(render, 1000);
