(function(){

  const btnBurger = document.getElementById('btnBurger');
  const btnClose  = document.getElementById('btnClose');
  const drawer    = document.getElementById('drawer');
  const backdrop  = document.getElementById('backdrop');
  const frame     = document.getElementById('contentFrame');
  const welcome   = document.getElementById('welcome');

  function openDrawer(){
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden','false');
    btnBurger.setAttribute('aria-expanded','true');
    backdrop.hidden = false;
  }

  function closeDrawer(){
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden','true');
    btnBurger.setAttribute('aria-expanded','false');
    backdrop.hidden = true;
  }

  btnBurger.addEventListener('click', openDrawer);
  btnClose.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  function openInFrame(url){
    try{
      frame.src = url;
      frame.style.display = 'block';
      if (welcome) welcome.style.display = 'none';
      closeDrawer();
    }catch(e){}
  }

  document.querySelectorAll('[data-src]').forEach((btn)=>{
    btn.addEventListener('click', () => {
      const url = btn.getAttribute('data-src');
      if (url) openInFrame(url);
    });
  });

  let startX = null;
  drawer.addEventListener('touchstart', (e)=>{
    startX = e.touches && e.touches[0] ? e.touches[0].clientX : null;
  }, {passive:true});
  drawer.addEventListener('touchend', (e)=>{
    if(startX == null) return;
    const endX = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : startX;
    if(endX - startX < -60) closeDrawer();
    startX = null;
  }, {passive:true});

  function initDynamicLinks() {

    const candidates = [
      new URL('./links.json', location.href).toString(),

      '/commerce/links.json',
      '/commerce/links.json'
    ];

    const cleanUrl = (value) => {
      const s = String(value || '').trim();
      if (!s) return '';
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1).trim();
      }
      return s;
    };

    const fetchFirstOk = async () => {
      for (const url of candidates) {
        try {
          const r = await fetch(url, {
            cache: 'no-store',
            credentials: 'omit',
            headers: { 'Accept': 'application/json' },
          });
          if (!r.ok) continue;
          const data = await r.json();
          const bosch = cleanUrl(data?.televenteBosch || data?.televente_bosch);
          const lub = cleanUrl(data?.televenteLub || data?.televente_lub || data?.televente_lubrifiant);
          if (!bosch && !lub) continue;
          return { televenteBosch: bosch, televenteLub: lub };
        } catch (_) {
        }
      }
      return null;
    };

    fetchFirstOk().then((data) => {
      if (!data) return;
      const bosch = cleanUrl(data?.televenteBosch || data?.televente_bosch);
      const lub   = cleanUrl(data?.televenteLub || data?.televente_lub || data?.televente_lubrifiant);

      document.querySelectorAll('[data-id]').forEach((btn) => {
        const id = btn.getAttribute('data-id');
        let url = null;
        if (id === 'televente-bosch') url = bosch;
        else if (id === 'televente-lub') url = lub;
        if (url) btn.addEventListener('click', () => openInFrame(url));
      });
    }).catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDynamicLinks);
  } else {
    initDynamicLinks();
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}
