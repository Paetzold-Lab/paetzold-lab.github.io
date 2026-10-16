document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("header-loaded", initializeHeader);
  document.addEventListener("search-overlay-loaded", initializeSearch);

  initializeUI();
  initializeCarousel();
  initializeContactForm();
  initializeGallery();
  initializeCollaboratorScrolling();
});

const SEARCH_PAGES = [
  "index.html",
  "team.html",
  "research.html",
  "join_us.html",
  "contact.html",
  "pi.html",
  "team_members_subpage/Adina.html",
  "team_members_subpage/Laurin.html",
  "team_members_subpage/Lucas.html",
  "team_members_subpage/Matt.html",
  "team_members_subpage/Roel.html"
];
const MAX_SEARCH_RESULTS = 12;
let searchIndexPromise = null;

function highlightTerm(value, term) {
  const text = String(value ?? "");
  const query = String(term ?? "");
  if (!query) return escapeHTML(text);
  const re = new RegExp(escapeRegExp(query), "gi");
  let lastIndex = 0;
  let output = "";
  text.replace(re, (match, offset) => {
    output += escapeHTML(text.slice(lastIndex, offset));
    output += `<span class="highlight">${escapeHTML(match)}</span>`;
    lastIndex = offset + match.length;
    return match;
  });
  return output + escapeHTML(text.slice(lastIndex));
}

function initializeHeader() {
  document
    .querySelector(".search-btn")
    ?.addEventListener("click", () => {
      const o = document.getElementById("search-overlay");
      if (!o) return;
      openOverlay(o);
      document.dispatchEvent(new CustomEvent("search-overlay-open"));
      document.querySelector(".search-input")?.focus();
    });
}

function openOverlay(overlay) {
  overlay.previousFocus = document.activeElement;
  overlay.removeAttribute("inert");
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("overlay-open");
  document.dispatchEvent(new CustomEvent("site-modal-change"));
}

function closeOverlay(overlay) {
  if (!overlay) return;
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("overlay-open");
  overlay.previousFocus?.focus?.();
  overlay.setAttribute("inert", "");
  document.dispatchEvent(new CustomEvent("site-modal-change"));
}

function initializeUI() {
  document.addEventListener("click", e => {
    if (e.target.matches(".overlay-close, .blur-bg")) closeOverlay(e.target.closest(".overlay"));
  });

  document.addEventListener("keydown", e => {
    const activeOverlay = document.querySelector(".overlay.active");
    if (!activeOverlay) return;
    if (e.key === "Escape") {
      closeOverlay(activeOverlay);
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = [...activeOverlay.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(element => element.tabIndex >= 0 && !element.hasAttribute("inert") && element.offsetParent !== null);
    if (!focusable.length) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  const title = document.querySelector(".typing-title");
  if (!title || !("IntersectionObserver" in window) || isReducedMotion()) return;

  const titleObserver = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("animate");
        titleObserver.unobserve(entry.target);
      });
    },
    { threshold: 0.5 }
  );
  titleObserver.observe(title);
}

function initializeSearch() {
  const input = document.querySelector(".search-input");
  const results = document.querySelector(".search-results");
  if (!input || !results) return;

  const renderResults = async () => {
    const rawQuery = input.value.trim();
    const q = rawQuery.toLowerCase();
    if (!q) {
      results.innerHTML = "";
      return;
    }

    results.innerHTML = '<div class="search-result-item is-loading">Searching...</div>';
    let index;
    try {
      index = await getSearchIndex();
    } catch {
      if (input.value.trim().toLowerCase() === q) {
        results.innerHTML = '<p class="search-result-item is-empty">Search could not load. Check your connection, then <button type="button" class="retry-search">try again</button>.</p>';
      }
      return;
    }
    if (input.value.trim().toLowerCase() !== q) return;

    const matches = index
      .filter(p => p.searchTitle.includes(q) || p.searchContent.includes(q))
      .sort((a, b) => Number(b.searchTitle.includes(q)) - Number(a.searchTitle.includes(q)))
      .slice(0, MAX_SEARCH_RESULTS);

    if (!matches.length) {
      results.innerHTML = '<div class="search-result-item is-empty">No results found.</div>';
      return;
    }

    results.innerHTML = matches
      .map(p => {
        let snippet = p.content;
        const i = p.searchContent.indexOf(q);
        if (i > -1) {
          const s = Math.max(0, i - 56);
          const e = Math.min(snippet.length, i + rawQuery.length + 72);
          snippet = (s ? "..." : "") + snippet.slice(s, e) + (e < p.content.length ? "..." : "");
        }

        return `
          <a class="search-result-item" href="${escapeHTML(p.url)}" data-url="${escapeHTML(p.url)}">
            <h3>${highlightTerm(p.title, rawQuery)}</h3>
            <p>${highlightTerm(snippet, rawQuery)}</p>
          </a>`;
      })
      .join("");
  };

  const debouncedRender = debounce(renderResults, 120);
  input.addEventListener("input", debouncedRender);
  input.addEventListener("focus", () => {
    if (!searchIndexPromise) getSearchIndex().catch(() => {});
  }, { once: true });
  document.addEventListener("search-overlay-open", () => getSearchIndex().catch(() => {}), { once: true });

  results.addEventListener("click", e => {
    if (e.target.closest(".retry-search")) {
      searchIndexPromise = null;
      renderResults();
      return;
    }
    const item = e.target.closest(".search-result-item");
    if (item?.dataset.url && item.tagName !== "A") window.location.href = item.dataset.url;
  });
}

async function getSearchIndex() {
  if (searchIndexPromise) return searchIndexPromise;
  searchIndexPromise = buildSearchIndex().catch(error => {
    console.warn("Unable to build search index", error);
    searchIndexPromise = null;
    throw error;
  });
  return searchIndexPromise;
}

async function buildSearchIndex() {
  const pageIndex = (
    await Promise.all(
      SEARCH_PAGES.map(async page => {
        try {
          const r = await fetch(versionedAssetURL(page));
          if (!r.ok) return null;
          const html = await r.text();
          const doc = new DOMParser().parseFromString(html, "text/html");
          doc.querySelectorAll("script, style, template, noscript").forEach(node => node.remove());
          return normalizeSearchEntry({
            title: doc.title || page,
            url: siteAssetPath(page),
            content: (doc.querySelector("main") || doc.body).textContent.replace(/\s+/g, " ").trim()
          });
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  let publicationIndex = [];
  try {
    const { publications } = await loadPublicationData();
    publicationIndex = publications.map(p => normalizeSearchEntry({
      title: p.title,
      url: `${siteAssetPath("research.html")}?q=${encodeURIComponent(p.title || "")}`,
      content: [
        p.title,
        p.authors,
        p.venue,
        p.year,
        p.summary,
        p.abstract,
        (p.source_members || []).join(" "),
        (p.categories || []).join(" "),
        (p.llm_tags || []).join(" ")
      ].filter(Boolean).join(" ")
    }));
  } catch {
    publicationIndex = [];
  }

  const index = [...pageIndex, ...publicationIndex];
  if (!index.length) throw new Error("Search is unavailable");
  // Partial results can still be useful, but a later search should retry missing data.
  if (pageIndex.length !== SEARCH_PAGES.length || !publicationIndex.length) searchIndexPromise = null;
  return index;
}

function normalizeSearchEntry(entry) {
  const title = String(entry.title || "Untitled").replace(/\s+/g, " ").trim();
  const content = String(entry.content || "").replace(/\s+/g, " ").trim();
  return {
    title,
    content,
    url: entry.url,
    searchTitle: title.toLowerCase(),
    searchContent: content.toLowerCase()
  };
}

function initializeCarousel() {
  const wrap = document.getElementById("carousel-wrapper");
  const carousel = wrap?.closest(".hero-carousel");
  if (!wrap || !carousel) return;
  wrap.carouselCleanup?.();
  const slides = [...wrap.querySelectorAll(".carousel-slide")];
  if (!slides.length) return;
  const controls = new AbortController();
  const { signal } = controls;
  const dots = [...document.querySelectorAll("#carousel-indicators .dot")];
  const pause = document.getElementById("carousel-pause");
  const prev = document.getElementById("carousel-prev");
  const next = document.getElementById("carousel-next");
  let idx = 0;
  let timer;
  let gesture = null;
  let suppressClick = false;
  wrap.carouselPaused ??= isReducedMotion();

  const stop = () => { clearInterval(timer); timer = null; };
  const update = () => {
    idx = (idx + slides.length) % slides.length;
    wrap.style.transform = `translateX(-${idx * 100}%)`;
    slides.forEach((slide, i) => {
      slide.classList.toggle("active", i === idx);
      slide.setAttribute("aria-hidden", String(i !== idx));
      slide.toggleAttribute("inert", i !== idx);
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", `${i + 1} of ${slides.length}`);
    });
    dots.forEach((dot, i) => {
      dot.classList.toggle("active", i === idx);
      dot.setAttribute("aria-current", String(i === idx));
    });
  };
  const sync = () => {
    stop();
    const paused = wrap.carouselPaused || isReducedMotion();
    if (pause) {
      pause.hidden = slides.length < 2;
      pause.textContent = paused ? "Play slideshow" : "Pause slideshow";
      pause.setAttribute("aria-label", paused ? "Play slideshow" : "Pause slideshow");
    }
    const active = !paused && slides.length > 1 && !document.hidden &&
      !carousel.matches(":hover") && !carousel.contains(document.activeElement) &&
      !document.querySelector(".overlay.active, .paper-zoom-modal.is-open, .legal-popup.active");
    wrap.setAttribute("aria-live", active ? "off" : "polite");
    if (active) timer = setInterval(() => { idx++; update(); }, 8000);
  };
  const goTo = index => { idx = index; update(); sync(); };
  dots.forEach((dot, i) => dot.addEventListener("click", () => goTo(i), { signal }));
  prev?.addEventListener("click", () => goTo(idx - 1), { signal });
  next?.addEventListener("click", () => goTo(idx + 1), { signal });
  [prev, next].forEach(button => { if (button) button.hidden = slides.length < 2; });
  pause?.addEventListener("click", () => {
    wrap.carouselPaused = !wrap.carouselPaused;
    sync();
  }, { signal });
  carousel.addEventListener("mouseenter", sync, { signal });
  carousel.addEventListener("mouseleave", sync, { signal });
  carousel.addEventListener("focusin", sync, { signal });
  carousel.addEventListener("focusout", () => queueMicrotask(sync), { signal });
  document.addEventListener("visibilitychange", sync, { signal });
  document.addEventListener("site-modal-change", sync, { signal });
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", sync, { signal });
  carousel.addEventListener("keydown", event => {
    if (!event.target.closest(".carousel-indicators, .carousel-arrow, #carousel-pause")) return;
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    goTo(idx + (event.key === "ArrowRight" ? 1 : -1));
  }, { signal });
  carousel.addEventListener("pointerdown", event => {
    if (event.button !== 0 || (event.pointerType === "mouse" && event.target.closest("a, button"))) return;
    suppressClick = false;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    stop();
  }, { signal });
  document.addEventListener("pointerup", event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      suppressClick = true;
      goTo(idx + (dx < 0 ? 1 : -1));
    } else sync();
  }, { signal });
  carousel.addEventListener("pointercancel", () => { gesture = null; sync(); }, { signal });
  carousel.addEventListener("click", event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true, signal });
  wrap.carouselCleanup = () => { stop(); controls.abort(); };
  update();
  sync();
}

const CONTACT_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbyEveVuAWICqewCw5FF8JnuQQwP8KEIFYgAmZShgnKzlTsIOBjRD3PSHilzQ12rxy1j/exec";
const CONTACT_FIELD_LIMITS = { name: 120, email: 200, message: 4000 };

function validateContactData(data) {
  for (const [field, limit] of Object.entries(CONTACT_FIELD_LIMITS)) {
    if (!data[field]) return { field, message: "Please complete this field." };
    if (data[field].length > limit) return { field, message: `Please use ${limit} characters or fewer.` };
  }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(data.email)) {
    return { field: "email", message: "Please enter a valid email address." };
  }
  if (data.message.length < 10) return { field: "message", message: "Please write at least 10 characters." };
  if ((data.message.match(/https?:\/\//g) || []).length > 4) {
    return { field: "message", message: "Please include no more than four links." };
  }
  return null;
}

async function sendContactMessage(data) {
  const result = await fetchJSONWithTimeout(CONTACT_ENDPOINT, {
    method: "POST",
    // A simple CORS request avoids an unsupported Apps Script preflight.
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(data),
    mode: "cors",
    credentials: "omit"
  });
  if (result?.ok !== true) throw new Error("The contact service did not confirm receipt");
}

function initializeContactForm() {
  const form = document.getElementById("contact-form");
  if (!form || form.dataset.initialized) return;
  form.dataset.initialized = "true";
  const button = form.querySelector(".submit-btn");
  if (!button) return;
  const originalText = button.textContent.trim();
  const status = document.createElement("p");
  status.className = "form-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  form.appendChild(status);
  const trap = document.createElement("div");
  trap.className = "form-trap";
  trap.setAttribute("aria-hidden", "true");
  trap.innerHTML = '<label for="contact-website">Leave this field empty</label>' +
    '<input type="text" id="contact-website" name="website" tabindex="-1" autocomplete="off">';
  form.appendChild(trap);
  const openedAt = Date.now();
  let pending = false;
  form.addEventListener("input", event => event.target.setCustomValidity?.(""));

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(form);
    const data = Object.fromEntries(Object.keys(CONTACT_FIELD_LIMITS)
      .map(key => [key, String(values.get(key) || "").trim()]));
    Object.assign(data, {
      website: String(values.get("website") || ""),
      elapsed: Date.now() - openedAt,
      page: window.location.origin + window.location.pathname
    });
    const invalid = validateContactData(data);
    if (invalid) {
      const input = form.elements.namedItem(invalid.field);
      input?.setCustomValidity(invalid.message);
      input?.reportValidity();
      input?.focus();
      return;
    }
    if (data.elapsed < 2500) {
      status.textContent = "Please wait a moment, then send your message.";
      return;
    }
    pending = true;
    button.disabled = true;
    button.textContent = "Sending…";
    form.setAttribute("aria-busy", "true");
    status.textContent = "Sending your message…";
    try {
      await sendContactMessage(data);
      status.textContent = "Thank you. Your message has been received.";
      form.reset();
    } catch {
      status.textContent = "We could not confirm delivery. Your message is still here. Please try again.";
    } finally {
      pending = false;
      button.disabled = false;
      button.textContent = originalText;
      form.removeAttribute("aria-busy");
    }
  });
}

function initializeHorizontalScroller(container, prev, next) {
  if (!container || !prev || !next) return;
  const sync = () => {
    // Leave room for fractional pixels and scroll-snap padding at either edge.
    prev.disabled = container.scrollLeft <= 8;
    next.disabled = container.scrollLeft >= container.scrollWidth - container.clientWidth - 8;
  };
  const move = direction => container.scrollBy({
    left: direction * Math.max(240, container.clientWidth * 0.8),
    behavior: isReducedMotion() ? "instant" : "smooth"
  });
  prev.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  container.addEventListener("scroll", sync, { passive: true });
  container.querySelectorAll("img").forEach(img => img.addEventListener("load", sync));
  if ("ResizeObserver" in window) new ResizeObserver(sync).observe(container);
  window.addEventListener("resize", sync, { passive: true });
  sync();
}

function initializeGallery() {
  const wrap = document.querySelector(".cards-scroll-wrapper.infinite-scroll");
  if (!wrap || wrap.dataset.galleryInitialized) return;
  wrap.dataset.galleryInitialized = "true";
  wrap.classList.add("is-static");
  initializeHorizontalScroller(wrap, document.getElementById("gallery-prev"), document.getElementById("gallery-next"));
}

function initializeCollaboratorScrolling() {
  initializeHorizontalScroller(
    document.querySelector(".collab-container"),
    document.querySelector(".collaborators .scroll-btn.prev"),
    document.querySelector(".collaborators .scroll-btn.next")
  );
}
