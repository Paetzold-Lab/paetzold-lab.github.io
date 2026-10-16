/* Injects the shared header/footer/search fragments into their placeholders.
   Path and version helpers come from site-utils.js, which loads first. */

document.addEventListener("DOMContentLoaded", () => {
  ["header", "footer", "search-overlay"].forEach(name => {
    const target = document.getElementById(`${name}-placeholder`);
    if (target) loadComponent(name, target);
  });
});

function loadComponent(name, target) {
  return fetch(versionedAssetURL(`components/${name}.html`))
    .then(response => {
      if (!response.ok) throw new Error(response.status);
      return response.text();
    })
    .then(html => {
      target.innerHTML = html;
      // Fragments contain markup only; initialization lives in this script.
      target.querySelectorAll("script").forEach(script => script.remove());
      COMPONENT_INITIALIZERS[name]?.();
    })
    .catch(error => {
      target.dataset.componentError = name;
      // Keep the static navigation available if the component request fails.
      console.warn(`Unable to load ${name} component`, error);
    })
    .finally(() => document.dispatchEvent(new CustomEvent(`${name}-loaded`)));
}

const COMPONENT_INITIALIZERS = {
  header() {
    // Ensure header initialization runs even when this fragment is injected after DOMContentLoaded
    (function initHeader(){
      function run(){
        // --- Set active nav link ---
        const isInSubdirectory = window.location.pathname.includes('/team_members_subpage/');
        const file = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
        const map  = {
          'index.html'   : 'nav-home',
          'research.html': 'nav-research',
          'team.html'    : 'nav-team',
          'join_us.html' : 'nav-join',
          'pi.html'      : 'nav-team',
          'contact.html' : 'nav-contact'
        };
        const activeLink = document.getElementById(isInSubdirectory ? 'nav-team' : map[file]);
        if (activeLink) {
          activeLink.classList.add('active');
          activeLink.setAttribute('aria-current', 'page');
          requestAnimationFrame(() => {
            const nav = activeLink.closest('.top-nav');
            if (nav && nav.scrollWidth > nav.clientWidth) {
              const navRect = nav.getBoundingClientRect();
              const linkRect = activeLink.getBoundingClientRect();
              const isClipped = linkRect.left < navRect.left || linkRect.right > navRect.right;
              if (isClipped) {
                nav.scrollLeft += linkRect.left - navRect.left - (navRect.width - linkRect.width) / 2;
              }
            }
          });
        }

        const hrefs = {
          'nav-logo': 'index.html',
          'nav-home': 'index.html',
          'nav-research': 'research.html',
          'nav-team': 'team.html',
          'nav-join': 'join_us.html',
          'nav-contact': 'contact.html'
        };
        Object.entries(hrefs).forEach(([id, path]) => {
          const link = document.getElementById(id);
          if (!link) return;
          const href = window.PaetzoldSite?.assetPath
            ? window.PaetzoldSite.assetPath(path)
            : `${isInSubdirectory ? '../' : './'}${path}`;
          link.setAttribute('href', href);
        });
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run, { once: true });
      } else {
        run();
      }
    })();
  },
  footer() {
    (()=>{
      const y=new Date().getFullYear();
      document.getElementById('current-year').textContent=y;
      document.querySelectorAll('.year-span').forEach(e=>e.textContent=y);
      document.getElementById('footer-contact').href = window.PaetzoldSite.assetPath('contact.html');

      document.querySelectorAll('img.footer-logo[data-file]').forEach(img=>{
        const file = img.getAttribute('data-file');
        if (!file) return;
        const desired = window.PaetzoldSite?.assetPath
          ? window.PaetzoldSite.assetPath('images/logo/' + file)
          : './images/logo/' + file;
        if (img.getAttribute('src') !== desired) img.setAttribute('src', desired);
        img.loading = 'lazy';
        img.decoding = 'async';
      });

      // Legal notice popup logic
      const open=document.getElementById('open-legal-notice');
      const popup=document.getElementById('legal-notice-popup');
      if (!open || !popup) return;
      const closeBtn=popup.querySelector('.legal-popup-close');
      const backdrop=popup.querySelector('.legal-popup-backdrop');
      let previousFocus=null;
      const show=()=>{
        previousFocus=document.activeElement;
        popup.removeAttribute('inert');
        popup.classList.add('active');
        popup.setAttribute('aria-hidden','false');
        document.body.style.overflow='hidden';
        closeBtn?.focus();
        document.dispatchEvent(new CustomEvent('site-modal-change'));
      };
      const hide=()=>{
        popup.classList.remove('active');
        document.body.style.overflow='';
        previousFocus?.focus?.();
        popup.setAttribute('aria-hidden','true');
        popup.setAttribute('inert','');
        document.dispatchEvent(new CustomEvent('site-modal-change'));
      };
      open.addEventListener('click',e=>{e.preventDefault();show()});
      closeBtn?.addEventListener('click',hide);
      backdrop?.addEventListener('click',hide);
      document.addEventListener('keydown',e=>{
        if(!popup.classList.contains('active')) return;
        if(e.key==='Escape') { hide(); return; }
        if(e.key!=='Tab') return;
        const focusable=[...popup.querySelectorAll('a[href],button:not([disabled])')].filter(element=>element.tabIndex>=0&&element.offsetParent!==null);
        if(!focusable.length) return;
        const first=focusable[0];
        const last=focusable[focusable.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
      });
    })();
  }
};
