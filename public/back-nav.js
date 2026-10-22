// Back button for the iOS home-screen app. Pages without their own way back
// draw a round button in the top-left corner. It goes back when the previous
// page is on this site, else to the tag's data-home ('/', '/gameday.html', '/admin/').
// Pages with their own back control mark it data-back-nav; no floating button
// is drawn there. Tag options: data-z, data-top, data-if-history. One script
// tag per page, like clock-fab.js.
// Audit: docs/ios-back-navigation-audit-2026-10-16.md.
(function () {
  const tag = document.currentScript || document.querySelector('script[src*="back-nav.js"]');
  const home = (tag && tag.getAttribute('data-home')) || '/';
  const isHomeScreen = window.navigator.standalone === true;
  if (isHomeScreen) document.documentElement.classList.add('ios-app');

  // Is there a page on this site to go back to? The Navigation API knows
  // (its entries are this site's only). Older iOS: history length plus a
  // same-site referrer, which a forward entry after a shim redirect can fool.
  function canGoBack() {
    if (window.navigation && typeof window.navigation.canGoBack === 'boolean') {
      return window.navigation.canGoBack;
    }
    if (history.length <= 1) return false;
    try {
      const referrer = new URL(document.referrer);
      return referrer.origin === location.origin;
    } catch (_) {
      return false;
    }
  }

  function go() {
    if (isHomeScreen) {
      if (canGoBack()) history.back();
      else location.href = home;
      return;
    }
    history.back();
  }

  window.BackNav = { go, canGoBack, home, ios: isHomeScreen };

  if (!isHomeScreen || !tag || document.querySelector('[data-back-nav]') ||
      document.getElementById('backNavBtn')) return;
  if (tag.hasAttribute('data-if-history') && !canGoBack()) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'backNavBtn';
  button.setAttribute('aria-label', 'Back');
  button.textContent = '←';
  const top = tag.getAttribute('data-top') || '10px';
  Object.assign(button.style, {
    position: 'fixed',
    top: 'calc(env(safe-area-inset-top, 0px) + ' + top + ')',
    left: 'calc(env(safe-area-inset-left, 0px) + 10px)',
    zIndex: tag.getAttribute('data-z') || '150',
    width: '40px', height: '40px', borderRadius: '50%',
    background: '#1a1a1a', border: '1px solid rgba(212,175,55,0.5)', color: '#e8e8e8',
    boxShadow: '0 2px 12px rgba(0,0,0,0.5)', cursor: 'pointer', padding: '0',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '1.4rem', fontWeight: '800', lineHeight: '1',
    appearance: 'none', WebkitAppearance: 'none'
  });
  button.addEventListener('click', go);
  document.body.appendChild(button);
  document.documentElement.classList.add('back-nav-on');
})();
