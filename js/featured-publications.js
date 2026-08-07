const HERO_PUBLICATION_IDS = [
  "auto_482c89c131", // Adina Scheinfeld: LSFM foundation model
  "auto_09034b913d", // Laurin Lux / Alexander Berger: MIDL
  "auto_74ca8cdcb0", // Lucas Stoffl: VERITAS
  "auto_82686f45e6", // Roel van Herten: GeoReg
  "auto_ebdd832b58", // Chenjun Li: MELD
  "auto_6295fd2b61"  // Chenjun/Laurin/Alex: medical VLM
];

const HERO_IMAGE_SETS = {
  auto_482c89c131: [
    { src: "./images/publications/hero/auto_482c89c131-primary.jpg", label: "Light-sheet microscopy task examples" },
    { src: "./images/publications/hero/auto_482c89c131-results.jpg", label: "Few-shot task performance" }
  ],
  auto_09034b913d: [
    { src: "./images/publications/hero/auto_09034b913d-primary.jpg", label: "Gradient surgery visual analysis" },
    { src: "./images/publications/hero/auto_09034b913d-gradient.jpg", label: "Gradient dynamics curves" }
  ],
  auto_74ca8cdcb0: [
    { src: "./images/publications/hero/auto_74ca8cdcb0-primary.jpg", label: "VERITAS architecture and evidence flow" },
    { src: "./images/publications/hero/auto_74ca8cdcb0-provenance.jpg", label: "Artifact provenance graph" }
  ],
  auto_82686f45e6: [
    { src: "./images/publications/hero/auto_82686f45e6-primary.jpg", label: "Biplanar DSA-to-CTA registration geometry" },
    { src: "./images/publications/hero/auto_82686f45e6-method.jpg", label: "GeoReg method overview" }
  ],
  auto_ebdd832b58: [
    { src: "./images/publications/hero/auto_ebdd832b58-primary.jpg", label: "MELD overview", position: "right center" },
    { src: "./images/publications/hero/auto_ebdd832b58-umap.jpg", label: "Generator separability embedding" }
  ],
  auto_6295fd2b61: [
    { src: "./images/publications/hero/auto_6295fd2b61-primary.jpg", label: "Synthetic vasculature reasoning framework" },
    { src: "./images/publications/hero/auto_6295fd2b61-pathology.jpg", label: "Synthetic DR pathologies" },
    { src: "./images/publications/hero/auto_6295fd2b61-reasoning.jpg", label: "OCTA reasoning example" }
  ],
  pub119: [
    { src: "./images/publications/hero/pub119-primary.jpg", label: "Graph-based VLM method overview" },
    { src: "./images/publications/hero/pub119-tuning.jpg", label: "Instruction tuning example" },
    { src: "./images/publications/hero/pub119-interpretability.jpg", label: "Interpretability comparison" },
    { src: "./images/publications/hero/pub119-octa.jpg", label: "OCTA heatmap detail", position: "center top" }
  ],
  pub002: [
    { src: "./images/publications/hero/pub002-primary.jpg", label: "Soft-clDice topology-preserving workflow" },
    { src: "./images/publications/hero/pub002-input.jpg", label: "Retinal input image" },
    { src: "./images/publications/hero/pub002-mask.jpg", label: "Mask and soft skeleton comparison" },
    { src: "./images/publications/hero/pub002-module.jpg", label: "Soft-clDice module" }
  ]
};

const HERO_TEASERS = {
  auto_482c89c131: "Few labels, many light-sheet microscopy tasks.",
  auto_09034b913d: "Calibrated segmentation without sacrificing accuracy.",
  auto_74ca8cdcb0: "Auditable agents test image-derived clinical hypotheses.",
  auto_82686f45e6: "Direct DSA-to-CTA registration for stroke workflows.",
  auto_ebdd832b58: "Robust AI-text detection across attacks and domains.",
  auto_6295fd2b61: "Synthetic OCTA data teaches VLMs clinical reasoning."
};

const LAB_INTRO_SLIDE = {
  title: "Machine learning for medical imaging, biology, and explainable AI.",
  summary: "The Paetzold Lab builds interpretable AI systems that connect geometric learning, generative models, multimodal data, and clinical translation.",
  image: "./images/team/paetzold-lab-group-2026.jpg",
  image2x: "./images/team/paetzold-lab-group-2026@2x.jpg"
};

async function getFeaturedPublications() {
  const { publications: pubs, categories } = await loadPublicationData();
  // 1. Explicit featured entries (preferred)
  const featured = pubs
    .filter(p => p.featured)
    .sort((a, b) => (a.featuredOrder ?? 999) - (b.featuredOrder ?? 999));
  if (featured.length) return featured;

  // 2. Legacy manual id list (kept for backward compatibility if old ids still exist)
  const manualIds = ["pub001", "pub028", "pub013", "pub055", "pub088", "pub006"];
  const manual = pubs
    .filter(p => manualIds.includes(p.id))
    .sort((a, b) => manualIds.indexOf(a.id) - manualIds.indexOf(b.id));
  if (manual.length) return manual;

  // 3. Category-based diverse selection (derive categories if top-level summary missing)
  let categoryMap = categories;
  if (!Object.keys(categoryMap).length) {
    categoryMap = {};
    pubs.forEach(p => (p.categories || []).forEach(c => (categoryMap[c] = c)));
  }
  const auto = [];
  Object.keys(categoryMap).forEach(cat => {
    auto.push(
      ...pubs
        .filter(p => p.categories?.includes(cat))
        .sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0))
        .slice(0, 1) // take top 1 per category first for diversity
    );
  });
  // Fill remaining slots (up to 6) with next best across categories
  if (auto.length < 6) {
    const remaining = pubs
      .filter(p => !auto.find(a => a.id === p.id))
      .sort((a, b) => (b.citations ?? 0) - (a.citations ?? 0));
    auto.push(...remaining.slice(0, 6 - auto.length));
  }
  if (auto.length) {
    return auto
      .filter((v, i, arr) => arr.findIndex(x => x.id === v.id) === i)
      .slice(0, 6);
  }

  // 4. Absolute fallback: pick top 6 by citations or by year if citations absent
  const scored = [...pubs].sort((a, b) => {
    const ca = a.citations ?? 0;
    const cb = b.citations ?? 0;
    if (cb !== ca) return cb - ca;
    const ya = a.year ?? 0;
    const yb = b.year ?? 0;
    return yb - ya;
  });
  return scored.slice(0, 6);
}

function heroTeaser(pub) {
  return HERO_TEASERS[pub?.id] || ellipsis(pub?.summary || pub?.abstract || "", 88);
}

function publicationSearchUrl(pub) {
  return `research.html?q=${encodeURIComponent(pub.title || "")}`;
}

function heroImageAttrs(slideIndex, imageIndex) {
  if (slideIndex === 0) {
    return imageIndex === 0
      ? 'loading="eager" fetchpriority="high" decoding="async"'
      : 'loading="eager" decoding="async"';
  }
  return 'loading="lazy" decoding="async"';
}

function selectHeroPublications(pubs) {
  const byId = new Map(pubs.map(pub => [pub.id, pub]));
  const selected = HERO_PUBLICATION_IDS
    .map(id => byId.get(id))
    .filter(Boolean);
  const selectedIds = new Set(selected.map(pub => pub.id));
  pubs.forEach(pub => {
    if (selected.length < HERO_PUBLICATION_IDS.length && !selectedIds.has(pub.id)) {
      selected.push(pub);
      selectedIds.add(pub.id);
    }
  });
  return selected.slice(0, HERO_PUBLICATION_IDS.length);
}

function heroCollageItems(pub) {
  const classes = ["primary", "secondary", "tertiary", "quaternary"];
  const imageSet = HERO_IMAGE_SETS[pub?.id] || [
    { src: publicationImage(pub), label: pub?.title || "Featured research" }
  ];
  const uniqueItems = imageSet
    .filter(item => normalizeLink(item.src))
    .filter((item, index, array) => array.findIndex(other => normalizeLink(other.src) === normalizeLink(item.src)) === index)
    .slice(0, classes.length);
  return uniqueItems.map((item, offset) => {
    const figureLabel = item.label || pub?.title || "Featured research figure";
    const fullLabel = item.label ? `${pub?.title || "Featured research"} - ${item.label}` : figureLabel;
    const src = normalizeLink(item.src) || publicationImage(pub);
    return {
      className: classes[offset],
      src: versionedImage(src),
      position: item.position || "center",
      title: figureLabel,
      ariaLabel: fullLabel
    };
  });
}

function ensurePaperZoomModal() {
  let modal = document.getElementById("paper-zoom-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "paper-zoom-modal";
    modal.className = "paper-zoom-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.setAttribute("inert", "");
    modal.innerHTML = `
      <button type="button" class="paper-zoom-backdrop" tabindex="-1" aria-label="Close preview"></button>
      <div class="paper-zoom-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-zoom-title">
        <button type="button" class="paper-zoom-close" aria-label="Close preview">&times;</button>
        <div class="paper-zoom-image-wrap">
          <img src="${DEFAULT_PUBLICATION_IMAGE}" alt="">
        </div>
        <p class="paper-zoom-caption" id="paper-zoom-title"></p>
      </div>`;
    document.body.appendChild(modal);
  }

  if (!modal.dataset.bound) {
    modal.querySelector(".paper-zoom-backdrop")?.addEventListener("click", closePaperZoom);
    modal.querySelector(".paper-zoom-close")?.addEventListener("click", closePaperZoom);
    document.addEventListener("keydown", event => {
      if (!modal.classList.contains("is-open")) return;
      if (event.key === "Escape") {
        closePaperZoom();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...modal.querySelectorAll("button:not([disabled]), a[href]")].filter(element => element.tabIndex >= 0 && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    modal.dataset.bound = "true";
  }

  return modal;
}

function openPaperZoom(src, title) {
  const modal = ensurePaperZoomModal();
  const img = modal.querySelector(".paper-zoom-image-wrap img");
  const caption = modal.querySelector(".paper-zoom-caption");
  const dialog = modal.querySelector(".paper-zoom-dialog");
  modal.previousFocus = document.activeElement;
  if (img) {
    dialog?.classList.remove("is-wide", "is-tall");
    img.onload = () => {
      const ratio = (img.naturalWidth || 1) / (img.naturalHeight || 1);
      dialog?.classList.toggle("is-wide", ratio >= 0.85);
      dialog?.classList.toggle("is-tall", ratio < 0.85);
    };
    img.src = src || DEFAULT_PUBLICATION_IMAGE;
    img.alt = title || "Featured research figure";
  }
  if (caption) caption.textContent = title || "";
  modal.classList.add("is-open");
  modal.removeAttribute("inert");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("paper-zoom-open");
  modal.querySelector(".paper-zoom-close")?.focus();
}

function closePaperZoom() {
  const modal = document.getElementById("paper-zoom-modal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("paper-zoom-open");
  modal.previousFocus?.focus?.();
  modal.setAttribute("inert", "");
}

function bindPaperCollageZoom(scope = document) {
  ensurePaperZoomModal();
  if (scope.dataset?.collageZoomBound) return;
  scope.addEventListener("click", event => {
    const frame = event.target.closest?.(".paper-collage-frame");
    if (!frame || !scope.contains(frame)) return;
    event.preventDefault();
    event.stopPropagation();
    openPaperZoom(frame.dataset.zoomSrc, frame.dataset.zoomTitle);
  });
  if (scope.dataset) scope.dataset.collageZoomBound = "true";
}

function renderHeroPublications(pubs) {
  const wrap = document.getElementById("carousel-wrapper");
  const indicators = document.getElementById("carousel-indicators");
  if (!wrap || !indicators) return;

  const heroPubs = selectHeroPublications(pubs);
  if (!heroPubs.length) return;

  const labIntroSlide = `
      <div class="carousel-slide paper-slide lab-intro-slide active" aria-hidden="false">
        <div class="paper-bg lab-intro-bg">
          <figure class="lab-intro-photo">
            <img
              src="${escapeHTML(versionedImage(LAB_INTRO_SLIDE.image))}"
              srcset="${escapeHTML(versionedImage(LAB_INTRO_SLIDE.image))} 1200w, ${escapeHTML(versionedImage(LAB_INTRO_SLIDE.image2x))} 2400w"
              sizes="(max-width: 768px) 92vw, 720px"
              alt="Paetzold Lab group photo"
              loading="eager"
              fetchpriority="high"
              decoding="async">
          </figure>
        </div>
        <div class="slide-content paper-slide-content lab-intro-content">
          <h1>${escapeHTML(LAB_INTRO_SLIDE.title)}</h1>
          <p class="hero-paper-summary">${escapeHTML(LAB_INTRO_SLIDE.summary)}</p>
          <div class="lab-intro-actions">
            <a href="research.html" class="hero-btn">Explore research</a>
            <a href="team.html" class="hero-btn secondary">Meet the team</a>
          </div>
        </div>
      </div>`;

  const paperSlides = heroPubs.map((pub, index) => {
    const categories = visibleCategories(pub, 2);
    const summary = heroTeaser(pub);
    const venue = formatVenue(pub.venue);
    const demo = safeURL(pub.demo_url);
    const collageItems = heroCollageItems(pub);
    return `
      <div class="carousel-slide paper-slide" aria-hidden="true" inert>
        <div class="paper-bg">
          <div class="paper-collage" data-paper-id="${escapeHTML(pub.id || "")}" data-image-count="${collageItems.length}" aria-label="Featured research image collage for ${escapeHTML(pub.title || "paper")}">
            ${collageItems.map((item, imageIndex) => `
              <button type="button" class="paper-collage-frame ${item.className}" style="--paper-image-position:${escapeHTML(item.position)}" data-zoom-src="${escapeHTML(item.src)}" data-zoom-title="${escapeHTML(item.title)}" aria-label="Preview ${escapeHTML(item.ariaLabel)}">
                <img src="${escapeHTML(item.src)}" alt="" ${heroImageAttrs(index, imageIndex)} onerror="this.onerror=null;this.src='${DEFAULT_PUBLICATION_IMAGE}';">
              </button>`).join("")}
          </div>
        </div>
        <div class="slide-content paper-slide-content">
          <div class="hero-paper-kicker">
            <span>Featured research</span>
            ${pub.year ? `<span>${escapeHTML(pub.year)}</span>` : ""}
            ${categories.map(c => `<span>${escapeHTML(categoryLabel(c))}</span>`).join("")}
          </div>
          <h2>${escapeHTML(pub.title)}</h2>
          ${summary ? `<p class="hero-paper-summary">${escapeHTML(summary)}</p>` : ""}
          ${venue ? `<div class="hero-paper-venue" title="${escapeHTML(pub.venue || venue)}">${escapeHTML(venue)}</div>` : ""}
          <div class="hero-paper-actions">
            <a href="${escapeHTML(publicationSearchUrl(pub))}" class="hero-btn">View paper</a>
            ${demo ? `<a href="${escapeHTML(demo)}" class="hero-btn secondary" target="_blank" rel="noopener">Live demo</a>` : ""}
          </div>
        </div>
      </div>`;
  }).join("");

  wrap.innerHTML = labIntroSlide + paperSlides;

  const indicatorLabels = ["Paetzold Lab overview", ...heroPubs.map(pub => pub.title || "paper")];
  indicators.innerHTML = indicatorLabels
    .map((label, index) => `<button type="button" class="dot ${index === 0 ? "active" : ""}" aria-label="Go to slide ${index + 1}: ${escapeHTML(label)}" aria-current="${index === 0 ? "true" : "false"}"></button>`)
    .join("");

  window.initializeCarousel?.();
  bindPaperCollageZoom(wrap);
}

function scrollSetup(c, l, r) {
  if (!c || !l || !r) return;
  const dx = 400;
  l.addEventListener("click", () => c.scrollBy({ left: -dx, behavior: "smooth" }));
  r.addEventListener("click", () => c.scrollBy({ left: dx, behavior: "smooth" }));

  const sync = () => {
    const canScrollLeft = c.scrollLeft > 8;
    const canScrollRight = c.scrollLeft < c.scrollWidth - c.clientWidth - 10;
    l.disabled = !canScrollLeft;
    r.disabled = !canScrollRight;
    l.classList.toggle("is-disabled", !canScrollLeft);
    r.classList.toggle("is-disabled", !canScrollRight);
  };
  c.addEventListener("scroll", sync);
  c.scrollLeft = 0;
  sync();
}

document.addEventListener("DOMContentLoaded", async () => {
  const wrap = document.querySelector(".pub-featured");
  const left = document.getElementById("pub-left");
  const right = document.getElementById("pub-right");
  if (!wrap) return;

  wrap.textContent = "Loading publications...";
  let pubs = [];
  try {
    pubs = await getFeaturedPublications();
  } catch {
    wrap.textContent = "Unable to load publications.";
    return;
  }
  if (!pubs.length) {
    wrap.textContent = "No publications found.";
    return;
  }

  renderHeroPublications(pubs);

  wrap.innerHTML = pubs
    .map(p => {
      const url = safeURL(p.url) || safeURL(scholarURL(p.scholar_link)) || safeURL(p.pdf_link) || "#";
      const thumbnail = publicationImage(p);
      const members = displayMembers(p, 3);
      const venue = formatVenue(p.venue);
      return `
        <article class="pub-card">
          <a href="${escapeHTML(url)}" target="_blank" rel="noopener" class="pub-card-link">
              <div class="pub-card-image">
              <img src="${escapeHTML(thumbnail)}" alt="${escapeHTML(p.title)}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${DEFAULT_PUBLICATION_IMAGE}';">
            </div>
            <div class="pub-card-content">
              <div class="pub-card-meta">
                ${visibleCategories(p, 2)
                  .map(c => `<span class="pub-card-badge ${escapeClassName(c)}">${escapeHTML(categoryLabel(c))}</span>`)
                  .join("")}
                <span class="pub-card-badge year">${escapeHTML(p.year || "")}</span>
              </div>
              <h3 title="${escapeHTML(p.title)}">${escapeHTML(p.title)}</h3>
              ${venue ? `<p class="pub-card-venue" title="${escapeHTML(p.venue || venue)}">${escapeHTML(venue)}</p>` : ""}
              <div class="pub-metrics">
                ${p.citations ? `<span class="metric">${escapeHTML(p.citations)} citations</span>` : ""}
                ${members.shown.map(m => `<span class="metric">${escapeHTML(m)}</span>`).join("")}
                ${members.hidden ? `<span class="metric">+${members.hidden}</span>` : ""}
              </div>
            </div>
          </a>
        </article>`;
    })
    .join("");

  scrollSetup(wrap, left, right);

  const reducedMotion = isReducedMotion();
  wrap.querySelectorAll(".pub-card").forEach((card, i) => {
    if (reducedMotion) {
      card.style.opacity = 1;
      card.style.transform = "none";
      return;
    }
    card.style.opacity = 0;
    card.style.transform = "translateY(20px)";
    setTimeout(() => {
      card.style.transition = "opacity .5s ease,transform .5s ease";
      card.style.opacity = 1;
      card.style.transform = "translateY(0)";
    }, i * 80);
  });
});
