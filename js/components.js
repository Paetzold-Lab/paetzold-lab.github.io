/* Injects the shared header/footer/search fragments into their placeholders.
   Path and version helpers come from site-utils.js, which loads first. */

document.addEventListener("DOMContentLoaded", () => {
  ["header", "footer", "search-overlay"].forEach(name => {
    const target = document.getElementById(`${name}-placeholder`);
    if (target) loadComponent(name, target);
  });
});

function loadComponent(name, target) {
  fetch(versionedAssetURL(`components/${name}.html`))
    .then(response => {
      if (!response.ok) throw new Error(response.status);
      return response.text();
    })
    .then(html => {
      target.innerHTML = html;
      // innerHTML does not execute scripts; re-create them so fragments can self-init.
      target.querySelectorAll("script").forEach(script => {
        const replacement = document.createElement("script");
        [...script.attributes].forEach(attr => replacement.setAttribute(attr.name, attr.value));
        replacement.textContent = script.textContent;
        script.parentNode.replaceChild(replacement, script);
      });
    })
    .catch(error => {
      target.dataset.componentError = name;
      target.innerHTML = "";
      console.warn(`Unable to load ${name} component`, error);
    })
    .finally(() => document.dispatchEvent(new CustomEvent(`${name}-loaded`)));
}
