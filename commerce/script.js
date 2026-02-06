(function () {

  const btnBurger = document.getElementById('btnBurger');
  const btnClose  = document.getElementById('btnClose');
  const drawer    = document.getElementById('drawer');
  const backdrop  = document.getElementById('backdrop');
  const frame     = document.getElementById('contentFrame');
  const welcome   = document.getElementById('welcome');

  function openDrawer() {
    if (!drawer) return;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    if (btnBurger) btnBurger.setAttribute('aria-expanded', 'true');
    if (backdrop) backdrop.hidden = false;
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    if (btnBurger) btnBurger.setAttribute('aria-expanded', 'false');
    if (backdrop) backdrop.hidden = true;
  }

  if (btnBurger) btnBurger.addEventListener('click', openDrawer);
  if (btnClose)  btnClose.addEventListener('click', closeDrawer);
  if (backdrop)  backdrop.addEventListener('click', closeDrawer);

  if (frame) {
    frame.addEventListener('load', () => {
      frame.style.display = 'block';
      if (welcome) welcome.style.display = 'none';
    });
  }

  function openInFrame(url) {
    try {
      if (!frame) return;
      frame.src = url;
      frame.style.display = 'block';
      if (welcome) welcome.style.display = 'none';
      closeDrawer();
    } catch (e) {}
  }

  // --- Dynamic links (Televente) ---
  function initDynamicLinks() {
    const televenteLinks = { bosch: "", lub: "" };
    let loaded = false;

    const cleanUrl = (value) => {
      const s = String(value || '').trim();
      if (!s) return '';
      // remove surrounding quotes if any
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1).trim();
      }
      return s;
    };

    const loadLinksOnce = async () => {
      if (loaded) return;
      loaded = true;
      try {
        const r = await fetch('/commerce/links.json', {
          cache: 'no-store',
          credentials: 'omit',
          headers: { 'Accept': 'application/json' },
        });
        if (!r.ok) return;
        const data = await r.json();
        televenteLinks.bosch = cleanUrl(data?.televenteBosch || data?.televente_bosch);
        televenteLinks.lub   = cleanUrl(data?.televenteLub || data?.televente_lub || data?.televente_lubrifiant);
      } catch (_) {}
    };

    // Preload in background (no popup risk)
    loadLinksOnce().catch(() => {});

    // One single click handler for ALL buttons
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-src],[data-id]') : null;
      if (!btn) return;

      // 1) Internal pages -> iframe
      const src = btn.getAttribute('data-src');
      if (src) {
        e.preventDefault();
        openInFrame(src);
        return;
      }

      // 2) Televente -> new tab (avoid popup blocker: open immediately)
      const id = btn.getAttribute('data-id');
      if (id !== 'televente-bosch' && id !== 'televente-lub') return;

      e.preventDefault();

      const w = window.open('about:blank', '_blank', 'noopener');
      closeDrawer();

      (async () => {
        await loadLinksOnce();

        const url = (id === 'televente-bosch') ? televenteLinks.bosch : televenteLinks.lub;
        if (!url) { try { w && w.close(); } catch(_) {} return; }

        try { w.location.href = url; } catch (_) { window.location.href = url; }
      })();
    });

    // Swipe-to-close (mobile)
    let startX = null;
    if (drawer) {
      drawer.addEventListener('touchstart', (e) => {
        startX = e.touches && e.touches[0] ? e.touches[0].clientX : null;
      }, { passive: true });

      drawer.addEventListener('touchend', (e) => {
        if (startX == null) return;
        const endX = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : startX;
        if (endX - startX < -60) closeDrawer();
        startX = null;
      }, { passive: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDynamicLinks);
  } else {
    initDynamicLinks();
  }

})();

// Service Worker (cache/PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}
