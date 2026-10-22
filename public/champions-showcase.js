/**
 * Season-opening champion showcase.
 *
 * Week one of a season the standings surfaces are dead space — the timer's
 * Championship and Bounty panels have nothing to show, and the app's Standings
 * tab is bare. This fills that gap with last championship's podium photos, and
 * retires them on their own the moment real scores land.
 *
 * The gate is deliberately `gamesPlayed > 0` and NOT "the standings are empty".
 * getLeaderboard seeds unplayed auto-qualifiers into the standings with
 * points:0 / gamesPlayed:0 (functions/index.js), so an empty-length check would
 * hide the photos the instant a berth was granted, before anyone had played a
 * hand. Gating on games played keeps them up until the season actually starts.
 *
 * Photos are static hosting assets under /img/champions/ and are looked up by
 * convention, so rolling to a new season is "replace four files" — no Firestore
 * edit, no code change. Names are read from config/champions (the same doc that
 * feeds home.html's Wall of Fame) and are optional garnish: a stale or missing
 * name never suppresses the photo.
 */

const VENUE_SLUG = {
  'Tight End': 'te',
  'Wild Corgi': 'wc'
};

const AWARD_LABEL = {
  champion: 'Champion',
  gladiator: 'Gladiator'
};

/**
 * True once anyone has actually played this season.
 * @param {Array<{gamesPlayed?: number}>} standings - getLeaderboard standings
 */
export function seasonHasStarted(standings) {
  return (standings || []).some(p => (p.gamesPlayed || 0) > 0);
}

/**
 * Convention path for a venue's podium photo. Returns null for an unknown venue
 * so callers fall through to their normal empty state instead of a broken img.
 * @param {string} venue - 'Tight End' | 'Wild Corgi'
 * @param {string} award - 'champion' | 'gladiator'
 */
export function championPhotoUrl(venue, award) {
  const slug = VENUE_SLUG[venue];
  if (!slug || !AWARD_LABEL[award]) return null;
  return `/img/champions/${slug}-${award}.jpg`;
}

// Probe results by src. The showcase takes over a whole panel, so callers have
// to know the photo actually exists BEFORE they hide the leaderboard — an
// onerror that fires afterwards would leave the bar TV showing a blank box.
const photoStatus = new Map();

/**
 * Probe a podium photo. Call from the async load path; the render path then
 * reads the answer synchronously via championPhotoReady().
 * @returns {Promise<boolean>}
 */
export async function preloadChampionPhoto(venue, award) {
  const src = championPhotoUrl(venue, award);
  if (!src) return false;
  if (photoStatus.has(src)) return photoStatus.get(src);

  const ok = await new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
  photoStatus.set(src, ok);
  return ok;
}

/** Sync view of preloadChampionPhoto — false until a probe has confirmed. */
export function championPhotoReady(venue, award) {
  const src = championPhotoUrl(venue, award);
  return !!src && photoStatus.get(src) === true;
}

/**
 * Winner name for a venue + award out of a getHallOfFame() payload.
 * Returns '' when the doc is missing or stale — callers show the photo anyway.
 */
export function championName(hallOfFame, venue, award) {
  const entry = (hallOfFame || {})[venue] || {};
  const name = entry[award];
  return typeof name === 'string' && name.trim() && name !== 'TBD' ? name.trim() : '';
}

/**
 * Season the winners came from, e.g. 'Season 28'. The venues don't share season
 * numbering, so this is per-venue. Returns '' to fall back to 'Last Season'.
 */
export function championSeasonLabel(hallOfFame, venue) {
  const label = ((hallOfFame || {})[venue] || {}).seasonLabel;
  return typeof label === 'string' && label.trim() ? label.trim() : '';
}

/**
 * Markup for one showcase block. Emits `cs-` classes only — each page supplies
 * its own sizing, because the timer renders to a bar TV and the app renders to
 * a phone. The photo is `object-fit: contain` everywhere: these are three-person
 * podium group shots, and a cover-crop lops people out of frame.
 *
 * @param {object} opts
 * @param {string} opts.venue        - 'Tight End' | 'Wild Corgi'
 * @param {string} opts.award        - 'champion' | 'gladiator'
 * @param {string} [opts.name]       - winner name, optional
 * @param {string} [opts.seasonLabel] - e.g. 'Season 27'; defaults to 'Last Season'
 * @returns {string} HTML, or '' when there is no photo to show
 */
export function buildShowcaseHtml({ venue, award, name = '', seasonLabel = '' } = {}) {
  const src = championPhotoUrl(venue, award);
  if (!src) return '';

  const label = AWARD_LABEL[award];
  const season = seasonLabel || 'Last Season';
  const alt = `${venue} ${season} ${label.toLowerCase()} podium`;

  return `
    <div class="cs-showcase">
      <div class="cs-eyebrow">${escapeHtml(season)} ${escapeHtml(label)}</div>
      <img class="cs-photo" src="${src}" alt="${escapeHtml(alt)}"
           onerror="this.style.display='none'">
      ${name ? `<div class="cs-name">${escapeHtml(name)}</div>` : ''}
      <div class="cs-sub">${escapeHtml(venue)} · Standings start after the first game</div>
    </div>
  `;
}

/**
 * Markup for a GROUP of podium cards — one per venue for a single award.
 *
 * The timer uses this instead of buildShowcaseHtml so all four titles get shown
 * across the two panels (champions in the Championship panel, gladiators in the
 * Bounty panel) regardless of which venue's timer is running. Tight End's week
 * one had already passed before this shipped, so their winners would otherwise
 * never appear on a screen.
 *
 * Caption is deliberately ONE line per card ("Season 33 Gladiator · Alex
 * Wolfe") — two cards in a panel that previously held one leaves no room for
 * the stacked eyebrow/name/venue treatment.
 *
 * @param {object} opts
 * @param {string} [opts.award]     - single award: 'champion' | 'gladiator'
 * @param {string[]} [opts.awards]  - multiple awards; with both venues this
 *                                    yields the 2×2 grid (champions on the top
 *                                    row, gladiators below — awards iterate
 *                                    outer so each award forms a grid row)
 * @param {object} opts.hallOfFame  - getHallOfFame() payload
 * @param {string[]} opts.venues    - venues to include, in display order
 * @param {(venue:string, award:string)=>boolean} [opts.isReady] - photo preflight
 * @returns {string} HTML, or '' when nothing has a usable photo
 */
export function buildShowcaseGroupHtml({ award, awards, hallOfFame, venues = [], isReady } = {}) {
  const awardList = (Array.isArray(awards) && awards.length ? awards : [award])
    .filter(a => AWARD_LABEL[a]);
  if (!awardList.length) return '';

  const cards = [];
  for (const aw of awardList) {
    const label = AWARD_LABEL[aw];
    for (const venue of venues) {
      const src = championPhotoUrl(venue, aw);
      if (!src) continue;
      if (isReady && !isReady(venue, aw)) continue;

      const name   = championName(hallOfFame, venue, aw);
      const season = championSeasonLabel(hallOfFame, venue) || 'Last Season';
      const alt    = `${venue} ${season} ${label.toLowerCase()} podium`;

      cards.push(`
        <div class="cs-card">
          <img class="cs-photo" src="${src}" alt="${escapeHtml(alt)}"
               onerror="this.style.display='none'">
          <div class="cs-line">
            <span class="cs-title">${escapeHtml(season)} ${escapeHtml(label)}</span>${
              name ? `<span class="cs-dot"> · </span><span class="cs-who">${escapeHtml(name)}</span>` : ''
            }
          </div>
        </div>
      `);
    }
  }

  if (!cards.length) return '';
  return `<div class="cs-group cs-count-${cards.length}">${cards.join('')}</div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
