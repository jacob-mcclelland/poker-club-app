// update-check.js — shows a discreet "Update available" prompt when a new version deploys
(function () {
  if (!('serviceWorker' in navigator)) return;

  var banner;
  var refreshing = false;

  function showBanner() {
    if (document.getElementById('sw-update-banner')) return;

    banner = document.createElement('div');
    banner.id = 'sw-update-banner';
    banner.innerHTML =
      '<span style="flex:1">Update available</span>' +
      '<button id="sw-update-btn">Reload</button>' +
      '<button id="sw-dismiss-btn" title="Dismiss">✕</button>';

    var s = banner.style;
    s.cssText = [
      'position:fixed',
      'bottom:72px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:#1a1a1a',
      'border:1px solid #d4af37',
      'border-radius:24px',
      'padding:8px 12px 8px 16px',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'z-index:99999',
      'font-size:13px',
      'color:#fff',
      'white-space:nowrap',
      'box-shadow:0 4px 24px rgba(0,0,0,0.7)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'
    ].join(';');

    document.body.appendChild(banner);

    document.getElementById('sw-update-btn').onclick = function () {
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          return;
        }
        reg.update().then(function () {
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          } else {
            window.location.reload();
          }
        }).catch(function () {
          window.location.reload();
        });
      });
    };
    document.getElementById('sw-dismiss-btn').onclick = function () {
      banner.remove();
    };

    // Auto-dismiss after 20 seconds
    setTimeout(function () { if (banner) banner.remove(); }, 20000);
  }

  // Inject button styles
  var style = document.createElement('style');
  style.textContent =
    '#sw-update-banner button{background:#d4af37;color:#000;border:none;border-radius:12px;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:700;line-height:1.6}' +
    '#sw-dismiss-btn{background:transparent!important;color:#888!important;font-size:14px;padding:2px 6px!important}';
  document.head.appendChild(style);

  // Show banner when a new SW takes control (fires after skipWaiting + clients.claim)
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  // Also catch the case where a SW is already waiting when this page loads
  navigator.serviceWorker.ready.then(function (reg) {
    reg.update().catch(function () {});

    if (reg.waiting) {
      showBanner();
    }

    reg.addEventListener('updatefound', function () {
      var newWorker = reg.installing;
      newWorker.addEventListener('statechange', function () {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showBanner();
        }
      });
    });

    // Poll lightly for updates while the app stays open.
    setInterval(function () {
      reg.update().catch(function () {});
    }, 5 * 60 * 1000);
  });
})();
