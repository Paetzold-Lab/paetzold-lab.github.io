const ITEMS_PER_PAGE = 5;
const PI_NAME = "Johannes C. Paetzold";
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
const DATA_VERSION = window.PaetzoldSite?.componentVersion || "20260717f";

function siteAssetPath(path) {
  if (window.PaetzoldSite?.assetPath) return window.PaetzoldSite.assetPath(path);
  return `./${String(path || "").replace(/^\.?\//, "")}`;
}

function normalizeAuthorName(str) {
  return str.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeClassName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function compareMemberNames(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" });
}

function normalizeLink(value) {
  const link = String(value ?? "").trim();
  return link || null;
}

function doiURL(value) {
  const doi = String(value ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return doi ? `https://doi.org/${doi}` : null;
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

async function fetchPublications() {
  try {
    const url = new URL(siteAssetPath("data/publications.json"), window.location.href);
    url.searchParams.set("v", DATA_VERSION);
    const r = await fetch(url.href);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    publicationMeta = {
      lastUpdated: data.last_updated || "",
      automation: data.automation || null
    };
    if (data.categories) {
      categories = data.categories;
      updateFilterButtons(Object.keys(categories));
    }
    return (data.publications || []).map(p => ({
      ...p,
      thumbnail: normalizeLink(p.thumbnail) || "./images/publications/default.png",
      links: {
        pdf: normalizeLink(p.pdf_link),
        scholar: normalizeLink(p.url || p.scholar_link),
        doi: doiURL(p.doi)
      }
    }));
  } catch {
    return [];
  }
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

  container && (container.innerHTML = '<div class="loading">Loading publications...</div>');
  publications = await fetchPublications();
  updateMemberButtons(publications);
  updatePublicationMeta();

  const params = new URLSearchParams(window.location.search);
  const param = params.get("filter");
  if (param && (param === "all" || categories[param])) {
    activeFilter = param;
    document.querySelectorAll(".pub-filters button").forEach(b => b.classList.toggle("active", b.dataset.filter === activeFilter));
  }
  const memberParam = params.get("member");
  if (memberParam) {
    activeMember = memberParam;
    document.querySelectorAll(".pub-member-filters button").forEach(b => b.classList.toggle("active", b.dataset.member === activeMember));
  }
  const queryParam = params.get("q") || params.get("search");
  if (queryParam) {
    searchQuery = queryParam.toLowerCase();
    if (searchInput) searchInput.value = queryParam;
  }
  applyFiltersAndRender();

  let to;
  searchInput?.addEventListener("input", e => {
    clearTimeout(to);
    to = setTimeout(() => {
      searchQuery = e.target.value.toLowerCase();
      currentPage = 1;
      applyFiltersAndRender();
      const url = new URL(window.location);
      const value = e.target.value.trim();
      value ? url.searchParams.set("q", value) : url.searchParams.delete("q");
      window.history.replaceState({}, "", url);
    }, 300);
  });

  pages?.addEventListener("click", e => {
    const pageButton = e.target.closest("[data-page]");
    if (pageButton) {
      currentPage = +pageButton.dataset.page;
      applyFiltersAndRender();
      window.scrollTo({ top: document.querySelector(".publications").offsetTop - 100, behavior: "smooth" });
    }
  });

  prev?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      applyFiltersAndRender();
      window.scrollTo({ top: document.querySelector(".publications").offsetTop - 100, behavior: "smooth" });
    }
  });

  next?.addEventListener("click", () => {
    const total = Math.ceil(getFilteredPublications().length / ITEMS_PER_PAGE);
    if (currentPage < total) {
      currentPage++;
      applyFiltersAndRender();
      window.scrollTo({ top: document.querySelector(".publications").offsetTop - 100, behavior: "smooth" });
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
    const q = searchQuery;
    filtered = filtered.filter(
      p =>
        String(p.title || "").toLowerCase().includes(q) ||
        String(p.abstract || "").toLowerCase().includes(q) ||
        String(p.summary || "").toLowerCase().includes(q) ||
        String(p.authors || "").toLowerCase().includes(q) ||
        String(p.venue || "").toLowerCase().includes(q) ||
        String(p.doi || "").toLowerCase().includes(q) ||
        (p.source_members || []).join(" ").toLowerCase().includes(q) ||
        (p.categories || []).map(prettyCat).join(" ").toLowerCase().includes(q) ||
        (p.llm_tags || []).join(" ").toLowerCase().includes(q)
    );
  }
  if (activeMember) {
    const target = normalizeAuthorName(activeMember);
    const aliases = [activeMember, ...(LAB_MEMBER_ALIASES[activeMember] || [])].map(normalizeAuthorName);
    filtered = filtered.filter(p => {
      const members = (p.source_members || []).map(normalizeAuthorName);
      if (members.includes(target)) return true;
      const authorText = normalizeAuthorName(String(p.authors || ""));
      return aliases.some(alias => authorText.includes(alias));
    });
  }
  return sortPublications(filtered);
}

function ellipsis(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(";"), cut.lastIndexOf(","));
  return `${cut.slice(0, boundary > limit * 0.62 ? boundary : limit - 1).trim()}...`;
}

function formatVenue(value) {
  const text = String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";

  const compactVenues = [
    [/medical imaging with deep learning|MIDL/i, "Medical Imaging with Deep Learning (MIDL)"],
    [/medical image computing and computer-assisted|MICCAI/i, "MICCAI"],
    [/machine learning in medical imaging|MLMI/i, "MLMI"],
    [/information processing in medical imaging|IPMI/i, "IPMI"],
    [/computer vision and pattern recognition|CVPR/i, "CVPR"],
    [/international conference on computer vision|ICCV/i, "ICCV"],
    [/winter conference on applications of computer vision|WACV/i, "WACV"],
    [/learning representations|ICLR/i, "ICLR"],
    [/neural information processing systems|NeurIPS/i, "NeurIPS"],
    [/international symposium on biomedical image processing|ISBI/i, "ISBI"]
  ];

  const match = compactVenues.find(([pattern]) => pattern.test(text));
  return match ? match[1] : text;
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
      const pa = Number.isFinite(+a.promotion_rank) ? +a.promotion_rank : 9999;
      const pb = Number.isFinite(+b.promotion_rank) ? +b.promotion_rank : 9999;
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

function prettyCat(id) {
  if (categories[id]) return categories[id];
  if (/^[a-z]{2,4}$/.test(id)) return id.toUpperCase(); // e.g., mri -> MRI, ct -> CT
  return id
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function badges(cats) {
  if (!cats?.length) return '<span class="pub-category-badge other">Research</span>';
  return cats.map(c => `<span class="pub-category-badge ${escapeClassName(c)}">${escapeHTML(prettyCat(c))}</span>`).join("");
}

function visibleCategories(pub, limit = 4) {
  const categories = pub.categories?.length ? pub.categories : ["other"];
  const primary = pub.primary_category || categories[0];
  const ordered = [primary, ...categories].filter(Boolean);
  return ordered.filter((value, index, array) => array.indexOf(value) === index).slice(0, limit);
}

function tags(tagsList) {
  if (!tagsList?.length) return "";
  return `
    <div class="pub-tags">
      ${tagsList.slice(0, 6).map(tag => `<span>${escapeHTML(tag)}</span>`).join("")}
    </div>`;
}

function displayLabMembers(pub, limit = 4) {
  const members = (pub.source_members || []).filter(Boolean);
  const nonPi = members.filter(member => member !== PI_NAME).sort(compareMemberNames);
  const ordered = nonPi.length ? nonPi : [...members].sort(compareMemberNames);
  const shown = ordered.slice(0, limit);
  const hidden = Math.max(0, ordered.length - shown.length);
  return { shown, hidden };
}

function labMemberRow(pub) {
  const members = displayLabMembers(pub, 4);
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
  const thumbnail = escapeHTML((p.thumbnail || "./images/publications/default.png").trim());
  const imageLoading = index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  const doi = p.links.doi && p.links.doi !== p.links.scholar ? p.links.doi : "";
  const citationLabel = p.citations ? `${p.citations} citation${+p.citations === 1 ? "" : "s"}` : "";
  return `
    <article class="pub-item" data-categories="${escapeHTML(p.categories?.join(" ") || "other")}">
      <div class="pub-thumb"><img src="${thumbnail}" alt="${title}" ${imageLoading} decoding="async" onerror="this.onerror=null;this.src='./images/publications/default.png';"></div>
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
    box.innerHTML = '<div class="no-results">No publications found. Try changing your search criteria.</div>';
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
