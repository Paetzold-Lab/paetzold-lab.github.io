const COMPONENT_VERSION = "20260717f";
const COMPONENT_SCRIPT_URL = document.currentScript?.src
  ? new URL(document.currentScript.src, document.baseURI)
  : new URL("./js/components.js", document.baseURI);
const SITE_ROOT_URL = new URL("../", COMPONENT_SCRIPT_URL);

function assetPath(path) {
  const cleanPath = String(path || "").replace(/^\.?\//, "");
  return new URL(cleanPath, SITE_ROOT_URL).href;
}

window.PaetzoldSite = {
  ...(window.PaetzoldSite || {}),
  assetBasePath: SITE_ROOT_URL.href,
  assetPath,
  componentVersion: COMPONENT_VERSION
};

document.addEventListener("DOMContentLoaded", () => {
  const components = [
    { placeholder: "header-placeholder", name: "header" },
    { placeholder: "footer-placeholder", name: "footer" },
    { placeholder: "search-overlay-placeholder", name: "search-overlay" },
    { placeholder: "research-overlay-placeholder", name: "research-overlay" }
  ];

  components.forEach(c => {
    const el = document.getElementById(c.placeholder);
    if (el) loadComponent(c.name, el);
  });
});

function loadComponent(name, target) {
  const url = new URL(`components/${name}.html`, SITE_ROOT_URL);
  url.searchParams.set("v", COMPONENT_VERSION);

  fetch(url.href)
    .then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    })
    .then(html => {
      target.innerHTML = html;
      target.querySelectorAll("script").forEach(s => {
        const n = document.createElement("script");
        [...s.attributes].forEach(a => n.setAttribute(a.name, a.value));
        n.textContent = s.textContent;
        s.parentNode.replaceChild(n, s);
      });
      document.dispatchEvent(new CustomEvent(`${name}-loaded`));
    })
    .catch(error => {
      target.dataset.componentError = name;
      target.innerHTML = "";
      console.warn(`Unable to load ${name} component`, error);
      document.dispatchEvent(new CustomEvent(`${name}-loaded`));
    });
}
