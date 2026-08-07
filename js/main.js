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
  "pi.html"
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
      setTimeout(() => document.querySelector(".search-input")?.focus(), 300);
    });
}

function openOverlay(overlay) {
  overlay.previousFocus = document.activeElement;
  overlay.removeAttribute("inert");
  overlay.classList.add("active");
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("overlay-open");
}

function closeOverlay(overlay) {
  if (!overlay) return;
  overlay.classList.remove("active");
  overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("overlay-open");
  overlay.previousFocus?.focus?.();
  overlay.setAttribute("inert", "");
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
    const index = await getSearchIndex();
    if (input.value.trim().toLowerCase() !== q) return;

    const matches = index
      .filter(p => p.searchTitle.includes(q) || p.searchContent.includes(q))
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
    if (!searchIndexPromise) getSearchIndex();
  }, { once: true });
  document.addEventListener("search-overlay-open", () => getSearchIndex(), { once: true });

  results.addEventListener("click", e => {
    const item = e.target.closest(".search-result-item");
    if (item?.dataset.url && item.tagName !== "A") window.location.href = item.dataset.url;
  });
}

async function getSearchIndex() {
  if (searchIndexPromise) return searchIndexPromise;
  searchIndexPromise = buildSearchIndex().catch(error => {
    console.warn("Unable to build search index", error);
    return [];
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
          return normalizeSearchEntry({
            title: doc.title || page,
            url: siteAssetPath(page),
            content: doc.body.textContent.replace(/\s+/g, " ").trim()
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

  return [...pageIndex, ...publicationIndex];
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
  if (!wrap) return;

  const slides = [...wrap.querySelectorAll(".carousel-slide")];
  if (!slides.length) return;

  const carousel = wrap.closest(".hero-carousel");
  const dots = [...document.querySelectorAll("#carousel-indicators .dot")];
  const prev = document.getElementById("carousel-prev");
  const next = document.getElementById("carousel-next");
  if (wrap.carouselTimer) clearInterval(wrap.carouselTimer);
  let idx = 0;

  const update = () => {
    idx = (idx + slides.length) % slides.length;
    wrap.style.transform = `translateX(-${idx * 100}%)`;
    slides.forEach((slide, i) => {
      const active = i === idx;
      slide.classList.toggle("active", active);
      slide.setAttribute("aria-hidden", active ? "false" : "true");
      slide.toggleAttribute("inert", !active);
    });
    dots.forEach((d, i) => {
      const active = i === idx;
      d.classList.toggle("active", active);
      d.setAttribute("aria-current", active ? "true" : "false");
    });
  };

  const startTimer = () => {
    if (wrap.carouselTimer) clearInterval(wrap.carouselTimer);
    if (slides.length <= 1 || isReducedMotion() || document.hidden) return;
    wrap.carouselTimer = setInterval(() => ((idx = idx + 1), update()), 8e3);
  };
  const stopTimer = () => {
    if (wrap.carouselTimer) clearInterval(wrap.carouselTimer);
    wrap.carouselTimer = null;
  };

  const goTo = nextIndex => {
    idx = nextIndex;
    update();
    stopTimer();
    startTimer();
  };

  dots.forEach((d, i) => (d.onclick = () => goTo(i)));
  if (prev) prev.onclick = () => goTo(idx - 1);
  if (next) next.onclick = () => goTo(idx + 1);

  if (carousel && !carousel.dataset.swipeBound) {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    carousel.addEventListener("touchstart", event => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      tracking = true;
      stopTimer();
    }, { passive: true });

    carousel.addEventListener("touchend", event => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        goTo(idx + (dx < 0 ? 1 : -1));
      } else {
        startTimer();
      }
    }, { passive: true });

    carousel.addEventListener("touchcancel", () => {
      tracking = false;
      startTimer();
    }, { passive: true });

    carousel.addEventListener("pointerdown", event => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      tracking = true;
      stopTimer();
    });

    carousel.addEventListener("pointerup", event => {
      if (!tracking || event.pointerType !== "mouse") return;
      tracking = false;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        goTo(idx + (dx < 0 ? 1 : -1));
      } else {
        startTimer();
      }
    });

    carousel.addEventListener("pointercancel", () => {
      tracking = false;
      startTimer();
    });

    carousel.dataset.swipeBound = "true";
  }

  if (carousel && !carousel.dataset.autoPauseBound) {
    carousel.addEventListener("mouseenter", stopTimer);
    carousel.addEventListener("mouseleave", startTimer);
    carousel.addEventListener("focusin", stopTimer);
    carousel.addEventListener("focusout", startTimer);
    carousel.dataset.autoPauseBound = "true";
  }

  startTimer();
  if (!wrap.dataset.visibilityBound) {
    document.addEventListener("visibilitychange", () => {
      stopTimer();
      startTimer();
    });
    wrap.dataset.visibilityBound = "true";
  }

  update();
}

const CONTACT_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbyEveVuAWICqewCw5FF8JnuQQwP8KEIFYgAmZShgnKzlTsIOBjRD3PSHilzQ12rxy1j/exec";
const CONTACT_FIELD_LIMITS = { name: 120, email: 200, message: 4000 };

function initializeContactForm() {
  const form = document.getElementById("contact-form");
  if (!form) return;

  // Bots fill every input they find. A hidden field that must stay empty, plus a
  // minimum time-on-form, filters the low-effort ones before they reach the sheet.
  // The Apps Script re-checks both; this half only saves the round trip.
  const trap = document.createElement("div");
  trap.className = "form-trap";
  trap.setAttribute("aria-hidden", "true");
  trap.innerHTML =
    '<label for="contact-website">Leave this field empty</label>' +
    '<input type="text" id="contact-website" name="website" tabindex="-1" autocomplete="off">';
  form.appendChild(trap);
  const openedAt = Date.now();

  form.addEventListener("submit", e => {
    e.preventDefault();
    const btn = form.querySelector(".submit-btn");
    if (!btn) return;
    btn.dataset.originalText ||= btn.innerHTML;
    btn.innerHTML = "Sending...";
    btn.disabled = true;

    const formData = new FormData(form);
    const field = (key, fallbackId) =>
      String(formData.get(key) ?? document.getElementById(fallbackId)?.value ?? "")
        .trim()
        .slice(0, CONTACT_FIELD_LIMITS[key]);
    const data = {
      name: field("name", "name"),
      email: field("email", "email"),
      message: field("message", "message"),
      website: String(formData.get("website") || ""),
      elapsed: Date.now() - openedAt
    };

    fetch(CONTACT_ENDPOINT, {
      method: "POST",
      body: JSON.stringify(data),
      headers: { "Content-Type": "application/json" },
      mode: "no-cors"
    })
      .then(() => {
        btn.classList.add("success");
        btn.innerHTML = "Sent Successfully";
        form.reset();
        setTimeout(() => {
          btn.classList.remove("success");
          btn.innerHTML = btn.dataset.originalText;
          btn.disabled = false;
        }, 3000);
      })
      .catch(() => {
        btn.innerHTML = "Failed to Send";
        btn.style.backgroundColor = "#333";
        setTimeout(() => {
          btn.innerHTML = btn.dataset.originalText;
          btn.style.backgroundColor = "";
          btn.disabled = false;
        }, 3000);
      });
  });
}

function initializeGallery() {
  const wrap = document.querySelector(".cards-scroll-wrapper.infinite-scroll");
  if (!wrap || wrap.dataset.galleryInitialized) return;
  wrap.dataset.galleryInitialized = "true";

  const cards = [...wrap.querySelectorAll(".small-card:not(.clone)")];
  if (!cards.length) return;

  const rebuild = () => {
    wrap.querySelectorAll(".small-card.clone").forEach(c => c.remove());
    if (isReducedMotion()) {
      wrap.classList.add("is-static");
      wrap.style.animation = "none";
      return;
    }

    wrap.classList.remove("is-static");
    const baseWidth = cards.reduce((sum, card) => sum + card.getBoundingClientRect().width + 16, 0);
    const repeatCount = Math.max(2, Math.ceil((window.innerWidth * 2.2) / Math.max(baseWidth, 1)));
    for (let i = 0; i < repeatCount; i++) {
      cards.forEach(card => {
        const clone = card.cloneNode(true);
        clone.classList.add("clone");
        clone.setAttribute("aria-hidden", "true");
        clone.querySelectorAll("img").forEach(img => {
          img.loading = "lazy";
          img.decoding = "async";
        });
        wrap.appendChild(clone);
      });
    }

    wrap.style.animation = "none";
    wrap.offsetHeight;
    wrap.style.animation = `scrollLeft ${Math.max(75, cards.length * 10)}s linear infinite`;
  };

  const scheduleRebuild = debounce(() => requestAnimationFrame(rebuild), 180);
  rebuild();
  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(scheduleRebuild);
    resizeObserver.observe(wrap.parentElement || wrap);
  } else {
    window.addEventListener("resize", scheduleRebuild);
  }
}

function initializeCollaboratorScrolling() {
  const ct = document.querySelector(".collab-container");
  const prev = document.querySelector(".collaborators .scroll-btn.prev");
  const next = document.querySelector(".collaborators .scroll-btn.next");
  if (!ct || !prev || !next) return;

  const dx = 300;
  prev.addEventListener("click", () => ct.scrollBy({ left: -dx, behavior: "smooth" }));
  next.addEventListener("click", () => ct.scrollBy({ left: dx, behavior: "smooth" }));
}
