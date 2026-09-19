/* Shared helpers used by every page.
   Loaded first (classic script, defer) so components.js, main.js,
   featured-publications.js and the publications module can all reuse them. */

const SITE_VERSION = "20260919b";

const SITE_SCRIPT_URL = document.currentScript?.src
  ? new URL(document.currentScript.src, document.baseURI)
  : new URL("./js/site-utils.js", document.baseURI);
const SITE_ROOT_URL = new URL("../", SITE_SCRIPT_URL);

function siteAssetPath(path) {
  return new URL(String(path || "").replace(/^\.?\//, ""), SITE_ROOT_URL).href;
}

function versionedAssetURL(path) {
  const url = new URL(siteAssetPath(path));
  url.searchParams.set("v", SITE_VERSION);
  return url.href;
}

/* Same as versionedAssetURL, but leaves absolute/data URLs untouched. */
function versionedImage(src) {
  const link = normalizeLink(src);
  if (!link || /^(?:https?:|data:|blob:)/i.test(link)) return link;
  return versionedAssetURL(link);
}

window.PaetzoldSite = {
  ...(window.PaetzoldSite || {}),
  assetBasePath: SITE_ROOT_URL.href,
  assetPath: siteAssetPath,
  componentVersion: SITE_VERSION
};

/* --- text --- */

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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Trim to `limit` characters, preferring the nearest word boundary. */
function ellipsis(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf(";"), cut.lastIndexOf(","));
  return `${cut.slice(0, boundary > limit * 0.62 ? boundary : limit - 1).trim()}...`;
}

/* --- links --- */

function normalizeLink(value) {
  const link = String(value ?? "").trim();
  return link || null;
}

/* Publication metadata is partly scraped from Scholar/arXiv, so treat any link
   built from it as untrusted: escaping alone does not stop a `javascript:` href.
   Returns null for anything that is not http(s), mailto, or a relative path. */
function safeURL(value) {
  const link = normalizeLink(value);
  if (!link) return null;
  // Browsers strip tabs, newlines and control characters before resolving a URL, so
  // the scheme must be read from the stripped form or "java<TAB>script:" slips through.
  const probe = link.replace(/[\u0000-\u0020\u007f]+/g, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe) || probe.startsWith("//")) {
    // Allowlist rather than blocklist, so anything exotic fails closed.
    try {
      const { protocol } = new URL(probe, window.location.href);
      return ["http:", "https:", "mailto:"].includes(protocol) ? link : null;
    } catch {
      return null;
    }
  }
  return link; // relative path within the site
}

/* Scholar records are stored as site-relative paths ("/citations?..."). */
function scholarURL(value) {
  const link = normalizeLink(value);
  if (!link) return null;
  return link.startsWith("/") ? `https://scholar.google.com${link}` : link;
}

function doiURL(value) {
  const doi = String(value ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return doi ? `https://doi.org/${doi}` : null;
}

/* --- publications --- */

const PI_NAME = "Johannes C. Paetzold";
const DEFAULT_PUBLICATION_IMAGE = "./images/publications/default.png";

/* Fallback labels for categories missing from publications.json `categories`. */
const CATEGORY_LABELS = {
  "medical-imaging": "Medical Imaging",
  gnn: "GNN",
  vlm: "VLM",
  generative: "Generative AI",
  topology: "Topology",
  microscopy: "Microscopy",
  spectroscopy: "Spectroscopy",
  mri: "MRI",
  ct: "CT",
  pet: "PET",
  "x-ray": "X-ray",
  ultrasound: "Ultrasound",
  histology: "Histology",
  segmentation: "Segmentation",
  reconstruction: "Reconstruction",
  detection: "Detection",
  registration: "Registration",
  classification: "Classification",
  uncertainty: "Uncertainty",
  other: "Research"
};

function categoryLabel(id) {
  if (CATEGORY_LABELS[id]) return CATEGORY_LABELS[id];
  // Short all-lowercase ids are acronyms (mri -> MRI).
  if (/^[a-z]{2,4}$/.test(id)) return id.toUpperCase();
  return String(id)
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function fetchJSONWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Share the in-flight request with site search; failed requests remain retryable. */
let publicationDataPromise = null;
function loadPublicationData() {
  if (!publicationDataPromise) {
    publicationDataPromise = fetchJSONWithTimeout(versionedAssetURL("data/publications.json"))
      .then(data => {
        if (!Array.isArray(data.publications)) throw new Error("Invalid publication data");
        if (data.categories) Object.assign(CATEGORY_LABELS, data.categories);
        return {
          publications: data.publications,
          categories: data.categories || {},
          lastUpdated: data.last_updated || "",
          automation: data.automation || null
        };
      })
      .catch(error => {
        publicationDataPromise = null;
        throw error;
      });
  }
  return publicationDataPromise;
}

function publicationImage(pub) {
  return safeURL(pub?.thumbnail) || DEFAULT_PUBLICATION_IMAGE;
}

/* Primary category first, deduplicated, capped at `limit`. */
function visibleCategories(pub, limit) {
  const categories = pub.categories?.length ? pub.categories : ["other"];
  const ordered = [pub.primary_category || categories[0], ...categories].filter(Boolean);
  return ordered.filter((value, index, array) => array.indexOf(value) === index).slice(0, limit);
}

function compareMemberNames(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" });
}

/* Lab members to credit on a card: students/postdocs first, PI only if alone. */
function displayMembers(pub, limit) {
  const members = (pub.source_members || []).filter(Boolean);
  const nonPi = members.filter(member => member !== PI_NAME).sort(compareMemberNames);
  const ordered = nonPi.length ? nonPi : [...members].sort(compareMemberNames);
  const shown = ordered.slice(0, limit);
  return { shown, hidden: Math.max(0, ordered.length - shown.length) };
}

const COMPACT_VENUES = [
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

/* Scholar venue strings are long ("Proceedings of the 9th ..."); shorten known ones. */
function formatVenue(value) {
  const text = String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const match = COMPACT_VENUES.find(([pattern]) => pattern.test(text));
  return match ? match[1] : text;
}

/* --- misc --- */

function isReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function debounce(fn, wait = 120) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
