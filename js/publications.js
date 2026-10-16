const ITEMS_PER_PAGE = 5;
const LAB_MEMBERS = [
  "Adina Scheinfeld",
  "Alexander Berger",
  "Chenjun Li",
  "Johannes C. Paetzold",
  "Laurin Lux",
  "Lucas Stoffl",
  "Roel van Herten"
];

// Common abbreviated / variant forms appearing in publication metadata.
const LAB_MEMBER_ALIASES = {
  "Johannes C. Paetzold": ["Johannes Paetzold", "J Paetzold", "J C Paetzold", "Johannes C Paetzold", "JC Paetzold"],
  "Chenjun Li": ["Matt Li", "C Li", "C. Li"],
  "Laurin Lux": ["L Lux"],
  "Alexander Berger": ["A Berger", "A H Berger", "A. Berger", "A. H. Berger"],
  "Adina Scheinfeld": ["A Scheinfeld"],
  "Roel van Herten": ["Rudolf van Herten", "R van Herten", "R. van Herten", "R v Herten", "RLM van Herten"],
  "Lucas Stoffl": ["L Stoffl"]
};

function normalizeAuthorName(str) {
  return str.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

function updateSortDirectionControl(button) {
  if (!button) return;
  button.textContent = sortConfig.ascending ? "↑" : "↓";
  button.setAttribute("aria-label", sortConfig.ascending ? "Sort ascending" : "Sort descending");
}

const LAB_ALIAS_SET = new Set([
  ...LAB_MEMBERS.map(normalizeAuthorName),
  ...Object.values(LAB_MEMBER_ALIASES).flat().map(normalizeAuthorName)
]);

let publications = [];
let categories = {};
let publicationMeta = {};
let currentPage = 1;
let sortConfig = { field: "priority", ascending: true };
let activeFilter = "all";
let activeMember = "";
let searchQuery = "";

let publicationsLoaded = false;

async function fetchPublications() {
  const data = await loadPublicationData();
  publicationMeta = { lastUpdated: data.lastUpdated, automation: data.automation };
  categories = data.categories;
  updateFilterButtons(Object.keys(categories));
  return data.publications.map(p => ({
    ...p,
    thumbnail: publicationImage(p),
    links: {
      pdf: safeURL(p.pdf_link),
      scholar: safeURL(p.url) || safeURL(scholarURL(p.scholar_link)),
      doi: safeURL(doiURL(p.doi)),
      demo: safeURL(p.demo_url)
    }
  }));
}

async function loadAndRenderPublications() {
  const container = document.getElementById("publications-container");
  if (!container) return;
  publicationsLoaded = false;
  container.setAttribute("aria-busy", "true");
  container.innerHTML = '<p class="loading" role="status">Loading publications…</p>';
  try {
    publications = await fetchPublications();
    const params = new URLSearchParams(window.location.search);
    const topic = params.get("filter");
    activeFilter = categories[topic] ? topic : "all";
    const member = params.get("member") || "";
    activeMember = LAB_MEMBERS.includes(member) ? member : "";
    const query = (params.get("q") || params.get("search") || "").trim();
    searchQuery = query.toLowerCase();
    const input = document.querySelector(".pub-search input");
    if (input) input.value = query;
    updateMemberButtons(publications);
    publicationsLoaded = true;
    applyFiltersAndRender();
  } catch {
    container.innerHTML = '<div class="no-results" role="alert"><p>Publications could not be loaded. Please check your connection.</p><button type="button" class="action-button retry-publications">Try again</button></div>';
    const meta = document.getElementById("pub-update-meta");
    if (meta) meta.textContent = "Publication list unavailable.";
    const pages = document.querySelector(".page-numbers");
    if (pages) pages.innerHTML = "";
    document.querySelectorAll(".pagination-btn").forEach(button => { button.disabled = true; });
  } finally {
    container.removeAttribute("aria-busy");
  }
}

function clearPublicationFilters() {
  activeFilter = "all";
  activeMember = "";
  searchQuery = "";
  currentPage = 1;
  const input = document.querySelector(".pub-search input");
  if (input) input.value = "";
  const url = new URL(window.location);
  ["q", "search", "filter", "member"].forEach(key => url.searchParams.delete(key));
  window.history.replaceState({}, "", url);
  applyFiltersAndRender();
}

function updateFilterButtons(ids) {
  const box = document.querySelector(".pub-filters");
  if (!box) return;
  let html = `<button class="active" data-filter="all">All</button>`;
  ids.forEach(id => id !== "other" && (html += `<button data-filter="${escapeHTML(id)}">${escapeHTML(categories[id] || id)}</button>`));
  box.innerHTML = html;
  attachFilterListeners();
}

document.addEventListener("DOMContentLoaded", async () => {
  const container = document.getElementById("publications-container");
  const pages = document.querySelector(".page-numbers");
  const prev = document.querySelector(".pagination-btn.prev");
  const next = document.querySelector(".pagination-btn.next");
  const searchInput = document.querySelector(".pub-search input");
  const sortSel = document.getElementById("sort-select");
  const sortDir = document.getElementById("sort-direction");

  await loadAndRenderPublications();
  container?.addEventListener("click", event => {
    if (event.target.closest(".retry-publications")) loadAndRenderPublications();
    if (event.target.closest("[data-reset-filters]")) clearPublicationFilters();
  });
  document.getElementById("clear-pub-filters")?.addEventListener("click", clearPublicationFilters);

  let to;
  searchInput?.addEventListener("input", e => {
    clearTimeout(to);
    to = setTimeout(() => {
      searchQuery = e.target.value.trim().toLowerCase();
      currentPage = 1;
      applyFiltersAndRender();
      const url = new URL(window.location);
      const value = e.target.value.trim();
      url.searchParams.delete("search");
      value ? url.searchParams.set("q", value) : url.searchParams.delete("q");
      window.history.replaceState({}, "", url);
    }, 300);
  });

  pages?.addEventListener("click", e => {
    const pageButton = e.target.closest("[data-page]");
    if (pageButton) {
      currentPage = +pageButton.dataset.page;
      applyFiltersAndRender();
      window.scrollTo({ top: document.querySelector(".publications").offsetTop - 100, behavior: isReducedMotion() ? "instant" : "smooth" });
    }
  });

  prev?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      applyFiltersAndRender();
      window.scrollTo({ top: document.querySelector(".publications").offsetTop - 100, behavior: isReducedMotion() ? "instant" : "smooth" });
    }
  });

  next?.addEventListener("click", () => {
    const total = Math.ceil(getFilteredPublications().length / ITEMS_PER_PAGE);
    if (currentPage < total) {
      currentPage++;
      applyFiltersAndRender();
      window.scrollTo({ top: document.querySelector(".publications").offsetTop - 100, behavior: isReducedMotion() ? "instant" : "smooth" });
    }
  });

  sortSel?.addEventListener("change", () => {
    sortConfig.field = sortSel.value;
    sortConfig.ascending = sortConfig.field === "priority" || sortConfig.field === "title";
    updateSortDirectionControl(sortDir);
    currentPage = 1;
    applyFiltersAndRender();
  });

  sortDir?.addEventListener("click", () => {
    sortConfig.ascending = !sortConfig.ascending;
    updateSortDirectionControl(sortDir);
    currentPage = 1;
    applyFiltersAndRender();
  });

  updateSortDirectionControl(sortDir);
});

function attachFilterListeners() {
  document.querySelectorAll(".pub-filters button").forEach(btn =>
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll(".pub-filters button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentPage = 1;
      applyFiltersAndRender();

      const url = new URL(window.location);
      activeFilter === "all" ? url.searchParams.delete("filter") : url.searchParams.set("filter", activeFilter);
      window.history.replaceState({}, "", url);
    })
  );
}

function updateMemberButtons(list) {
  const box = document.querySelector(".pub-member-filters");
  if (!box) return;
  const present = new Set();
  list.forEach(pub => (pub.source_members || []).forEach(member => present.add(member)));
  const members = LAB_MEMBERS.filter(member => present.has(member)).sort(compareMemberNames);
  if (!members.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `
    <span class="member-filter-label">People</span>
    <button class="${activeMember ? "" : "active"}" data-member="">All members</button>
    ${members.map(member => `<button class="${member === activeMember ? "active" : ""}" data-member="${escapeHTML(member)}">${escapeHTML(member)}</button>`).join("")}
  `;
  attachMemberFilterListeners();
}

function attachMemberFilterListeners() {
  document.querySelectorAll(".pub-member-filters button").forEach(btn =>
    btn.addEventListener("click", () => {
      activeMember = btn.dataset.member || "";
      document.querySelectorAll(".pub-member-filters button").forEach(b => b.classList.toggle("active", b.dataset.member === activeMember));
      currentPage = 1;
      applyFiltersAndRender();

      const url = new URL(window.location);
      activeMember ? url.searchParams.set("member", activeMember) : url.searchParams.delete("member");
      window.history.replaceState({}, "", url);
    })
  );
}

function applyFiltersAndRender() {
  if (!publicationsLoaded) return;
  document.querySelectorAll(".pub-filters button").forEach(button => {
    const selected = button.dataset.filter === activeFilter;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll(".pub-member-filters button").forEach(button => {
    const selected = button.dataset.member === activeMember;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const clear = document.getElementById("clear-pub-filters");
  if (clear) clear.disabled = activeFilter === "all" && !activeMember && !searchQuery;
  const filtered = getFilteredPublications();
  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  currentPage = Math.min(currentPage, totalPages);
  renderPublications(filtered);
  updatePublicationMeta(filtered.length);
}

function updatePublicationMeta(visibleCount = publications.length) {
  const el = document.getElementById("pub-update-meta");
  if (!el) return;
  const count = publications.length;
  const date = publicationMeta.lastUpdated ? new Date(publicationMeta.lastUpdated) : null;
  const dateLabel = date && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "";
  const countLabel = visibleCount === count
    ? `${count} publications`
    : `${visibleCount} shown of ${count} publications`;
  el.textContent = dateLabel
    ? `${countLabel}. Scholar citation data last refreshed ${dateLabel}.`
    : `${countLabel}.`;
}

function getFilteredPublications() {
  let filtered =
    activeFilter === "all" ? publications : publications.filter(p => p.categories?.includes(activeFilter));

  if (searchQuery) {
    const q = searchQuery.trim();
    filtered = filtered.filter(
      p =>
        String(p.title || "").toLowerCase().includes(q) ||
        String(p.abstract || "").toLowerCase().includes(q) ||
        String(p.summary || "").toLowerCase().includes(q) ||
        String(p.authors || "").toLowerCase().includes(q) ||
        String(p.venue || "").toLowerCase().includes(q) ||
        String(p.doi || "").toLowerCase().includes(q) ||
        String(p.year || "").includes(q) ||
        (p.source_members || []).join(" ").toLowerCase().includes(q) ||
        (p.categories || []).map(categoryLabel).join(" ").toLowerCase().includes(q) ||
        (p.llm_tags || []).join(" ").toLowerCase().includes(q)
    );
  }
  if (activeMember) {
    const target = normalizeAuthorName(activeMember);
    const aliases = [activeMember, ...(LAB_MEMBER_ALIASES[activeMember] || [])].map(normalizeAuthorName);
    filtered = filtered.filter(p => {
      const members = (p.source_members || []).map(normalizeAuthorName);
      if (members.includes(target)) return true;
      const authors = String(p.authors || "").split(/[,;]|\band\b/i).map(normalizeAuthorName);
      return aliases.some(alias => authors.includes(alias));
    });
  }
  return sortPublications(filtered);
}

function highlightAuthors(str) {
  const pairs = LAB_MEMBERS.map(n => {
    const parts = n.split(/\s+/);
    const first = parts[0];
    // Handle compound last names like "van Herten"
    const last = parts.slice(1).join(" ") || "";
    return { f: first.toLowerCase(), fi: first[0].toLowerCase(), l: last.toLowerCase() };
  });

  return str
    .split(", ")
    .map(rawName => {
      const display = rawName.trim();
      const norm = normalizeAuthorName(display);
      const safeDisplay = escapeHTML(display);

      // Direct alias / full match
      let isLab = LAB_ALIAS_SET.has(norm);

      if (!isLab) {
        // Try initial + last name heuristic
        isLab = pairs.some(p => {
          if (!p.l) return false;
            // Match full first + last
          if (norm.includes(p.f) && norm.includes(p.l)) return true;
          // Match first initial + last (supports compound last names)
          const lastEsc = p.l.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
          const re = new RegExp(`^${p.fi}\\s+${lastEsc}$`); // e.g. c li
          if (re.test(norm)) return true;
          // With optional middle initial(s)
          const reMid = new RegExp(`^${p.fi}(?:\\s+[a-z]){0,2}\\s+${lastEsc}$`); // a h berger
          if (reMid.test(norm)) return true;
          return false;
        });
      }

      return isLab ? `<span class="lab-member">${safeDisplay}</span>` : safeDisplay;
    })
    .join(", ");
}

function formatAuthors(raw) {
  if (!raw) return "";
  const list = raw.replace(/ and /g, ", ").split(",").map(a => a.trim()).filter(Boolean);
  return list.length <= 5
    ? list.join(", ")
    : `${list.slice(0, 3).join(", ")}, ..., ${list.slice(-2).join(", ")}`;
}

function sortPublications(arr) {
  return [...arr].sort((a, b) => {
    if (sortConfig.field === "priority") {
      const pa = a.promotion_rank != null && Number.isFinite(+a.promotion_rank) ? +a.promotion_rank : 9999;
      const pb = b.promotion_rank != null && Number.isFinite(+b.promotion_rank) ? +b.promotion_rank : 9999;
      if (pa !== pb) return sortConfig.ascending ? pa - pb : pb - pa;
      const yearDiff = (+b.year || 0) - (+a.year || 0);
      if (yearDiff) return yearDiff;
      return (+b.citations || 0) - (+a.citations || 0);
    }

    let A = a[sortConfig.field] ?? "";
    let B = b[sortConfig.field] ?? "";
    if (sortConfig.field === "title") (A = A.toLowerCase()), (B = B.toLowerCase());
    if (["year", "citations"].includes(sortConfig.field)) (A = +A || 0), (B = +B || 0);
    if (A === B) return 0;
    const cmp = A < B ? -1 : 1;
    return sortConfig.ascending ? cmp : -cmp;
  });
}

function badges(cats) {
  if (!cats?.length) return '<span class="pub-category-badge other">Research</span>';
  return cats.map(c => `<span class="pub-category-badge ${escapeClassName(c)}">${escapeHTML(categoryLabel(c))}</span>`).join("");
}

function tags(tagsList) {
  if (!tagsList?.length) return "";
  return `
    <div class="pub-tags">
      ${tagsList.slice(0, 6).map(tag => `<span>${escapeHTML(tag)}</span>`).join("")}
    </div>`;
}

function labMemberRow(pub) {
  const members = displayMembers(pub, 4);
  if (!members.shown.length) return "";
  return `
    <div class="pub-lab-row">
      <span class="pub-lab-label">Lab</span>
      ${members.shown.map(member => `<span class="pub-lab-chip">${escapeHTML(member)}</span>`).join("")}
      ${members.hidden ? `<span class="pub-lab-chip">+${members.hidden}</span>` : ""}
    </div>`;
}

function renderPublication(p, index = 0) {
  const a = ellipsis(formatAuthors(p.authors), 180);
  const summary = ellipsis(p.summary || p.abstract, 320);
  const title = escapeHTML(p.title);
  const venue = escapeHTML(formatVenue(p.venue));
  const fullVenue = escapeHTML(p.venue || formatVenue(p.venue));
  const thumbnail = escapeHTML(versionedImage(publicationImage(p)));
  const imageLoading = index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const doi = p.links.doi && p.links.doi !== p.links.scholar ? p.links.doi : "";
  const citationLabel = p.citations ? `${p.citations} citation${+p.citations === 1 ? "" : "s"}` : "";
  return `
    <article class="pub-item" data-categories="${escapeHTML(p.categories?.join(" ") || "other")}">
      <div class="pub-thumb"><img src="${thumbnail}" alt="${title}" ${imageLoading} decoding="async" onerror="this.onerror=null;this.src='${DEFAULT_PUBLICATION_IMAGE}';"></div>
      <div class="pub-content">
        <div class="pub-topline">
          <div class="pub-categories">${badges(visibleCategories(p, 3))}</div>
          <div class="pub-stats">
            ${p.year ? `<span>${escapeHTML(p.year)}</span>` : ""}
            ${citationLabel ? `<span>${escapeHTML(citationLabel)}</span>` : ""}
          </div>
        </div>
        <h3 title="${title}">${title}</h3>
        <p class="authors">${highlightAuthors(a)}</p>
        ${labMemberRow(p)}
        <div class="pub-meta">
          <span class="venue-name" title="${fullVenue}">${venue}</span>
        </div>
        ${tags(p.llm_tags)}
        ${summary ? `<p class="abstract">${escapeHTML(summary)}</p>` : ""}
        <div class="pub-links">
          ${p.links.demo ? `<a href="${escapeHTML(p.links.demo)}" class="btn-link demo" target="_blank" rel="noopener" aria-label="Open live demo for ${title}">Demo</a>` : ""}
          ${p.links.pdf ? `<a href="${escapeHTML(p.links.pdf)}" class="btn-link pdf" target="_blank" rel="noopener" aria-label="Open PDF for ${title}">PDF</a>` : ""}
          ${doi ? `<a href="${escapeHTML(doi)}" class="btn-link doi" target="_blank" rel="noopener" aria-label="Open DOI for ${title}">DOI</a>` : ""}
          ${p.links.scholar ? `<a href="${escapeHTML(p.links.scholar)}" class="btn-link link" target="_blank" rel="noopener" aria-label="Open Scholar record for ${title}">Scholar</a>` : ""}
        </div>
      </div>
    </article>`;
}

function renderPublications(list) {
  const box = document.getElementById("publications-container");
  if (!box) return;

  if (!list.length) {
    box.innerHTML = '<div class="no-results">No publications match these filters. <button type="button" class="action-button" data-reset-filters>Clear filters</button></div>';
    const pages = document.querySelector(".page-numbers");
    if (pages) pages.innerHTML = "";
    document.querySelector(".pagination-btn.prev")?.setAttribute("disabled", "");
    document.querySelector(".pagination-btn.next")?.setAttribute("disabled", "");
    return;
  }

  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const slice = list.slice(start, start + ITEMS_PER_PAGE);
  box.innerHTML = slice.map((pub, index) => renderPublication(pub, index)).join("");
  updatePagination(list.length);
}

function updatePagination(total) {
  const pages = document.querySelector(".page-numbers");
  const prev = document.querySelector(".pagination-btn.prev");
  const next = document.querySelector(".pagination-btn.next");
  if (!pages || !prev || !next) return;

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
  const max = 5;
  let s = Math.max(1, currentPage - Math.floor(max / 2));
  let e = Math.min(totalPages, s + max - 1);
  if (e - s + 1 < max) s = Math.max(1, e - max + 1);

  let html = "";
  if (s > 1) {
    html += `<button type="button" data-page="1" aria-label="Go to page 1">1</button>`;
    if (s > 2) html += `<span class="ellipsis">...</span>`;
  }

  for (let i = s; i <= e; i++)
    html += `<button type="button" class="${i === currentPage ? "active" : ""}" data-page="${i}" aria-label="Go to page ${i}" ${i === currentPage ? 'aria-current="page"' : ""}>${i}</button>`;

  if (e < totalPages) {
    if (e < totalPages - 1) html += `<span class="ellipsis">...</span>`;
    html += `<button type="button" data-page="${totalPages}" aria-label="Go to page ${totalPages}">${totalPages}</button>`;
  }

  pages.innerHTML = html;
  prev.disabled = currentPage === 1;
  next.disabled = currentPage === totalPages;
}
