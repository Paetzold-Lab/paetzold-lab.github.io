# Paetzold Lab Website

## Directory Structure

```
├── components/             # Reusable HTML components
│   ├── footer.html
│   ├── header.html
│   └── search-overlay.html
├── css/                    # Stylesheets by section
│   ├── contact.css         # Contact page
│   ├── joinus.css          # Join us page
│   ├── research.css        # Research page
│   ├── research_show.css   # Research showcase
│   └── style.css           # Main styles
├── data/
│   └── publications.json   # Publication data
├── images/                 # Image assets
│   ├── collaborators/      # Partner logos
│   ├── logo/               # Lab logos
│   ├── portrait/           # Team photos
│   ├── publications/       # Publication thumbnails
│   └── team/               # Team photos
├── js/                     # JavaScript files
│   ├── site-utils.js       # Shared helpers; must load first on every page
│   ├── components.js       # Component loader
│   ├── featured-publications.js  # Homepage hero + featured cards
│   ├── main.js             # Header, search, carousel, gallery, contact form
│   └── publications.js     # Research page list (ES module)
├── scripts/                # Publication data pipeline
└── *.html                  # Main pages
```


## Setup

1. Ensure the `components` directory exists with all component files
2. Main pages reference components via placeholder elements:
   ```html
   <div id="header-placeholder"></div>
   <div id="search-overlay-placeholder"></div>
   <!-- Page content -->
   <div id="footer-placeholder"></div>
   ```
3. Publications are loaded from `data/publications.json`
4. Scripts load in order: `site-utils.js` → `components.js` → `main.js` → page script.
   `site-utils.js` owns `SITE_VERSION`, path/version helpers, and the shared
   publication helpers (`loadPublicationData`, `formatVenue`, `categoryLabel`, ...).

Component fragments contain markup only. Their initialization lives in
`js/components.js`, and image fallbacks use the shared error listener in
`js/site-utils.js`. Keep executable scripts and event handlers out of HTML
fragments: the Content Security Policy permits scripts from this origin and
blocks inline execution. JSON-LD metadata can remain in the page as inert data.

### Cache busting

Static assets are referenced as `?v=<token>`. When shipping CSS/JS changes, bump
`SITE_VERSION` in `js/site-utils.js` and the matching `?v=` token in every HTML page
(they must stay in sync).

## Development

### Local preview and checks

Serve the repository root over HTTP so shared components and publication data load:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/`. Before publishing, run these dependency-free checks
(Node.js 18+ and Python 3):

```bash
node --test scripts/site-regression.test.cjs
python3 scripts/check-site.py
```

The regression tests mock network requests; they never send contact messages.
Also check the homepage, research filters, search, and profile pages at mobile and
desktop widths. The contact form only confirms receipt after an acknowledged JSON
response from the Apps Script endpoint; failures retain the entered message.

### Adding Pages

Create new HTML files based on existing templates, including component placeholders and necessary CSS/JS references.

### Publication Management

The pipeline requires Python 3.10+ and the core dependencies below. Image and PDF
enrichment additionally needs `Pillow` and `PyMuPDF`.

```bash
python3 -m pip install -r scripts/requirements.txt
# Optional, for PDF extraction and thumbnail generation:
python3 -m pip install Pillow PyMuPDF
```

Update `data/publications.json` manually, or use the automated research pipeline:

```bash
# Enrich existing publications into data/publications.preview.json
python3 scripts/research_pipeline.py --enrich --download-pdfs --page-images --fallback-thumbnails --limit 10

# Add LLM-generated summaries/tags/categories when OPENAI_API_KEY is available
OPENAI_API_KEY=... python3 scripts/research_pipeline.py --enrich --download-pdfs --page-images --fallback-thumbnails --llm --limit 10

# Collect configured lab-member Google Scholar profiles, enrich, and preview
python3 scripts/research_pipeline.py --collect-scholar --representative --enrich --download-pdfs --page-images --fallback-thumbnails

# Normalize, verify metadata, mark representative papers, and write an audit report
python3 scripts/research_pipeline.py --normalize --verify-openalex --representative --audit

# Publish the generated data to data/publications.json after preview review
python3 scripts/research_pipeline.py --collect-scholar --normalize --verify-openalex --representative --enrich --download-pdfs --page-images --fallback-thumbnails --llm --audit --write

# Fill thumbnails only for representative publications that still use the default image
python3 scripts/research_pipeline.py --input data/publications.json --enrich --download-pdfs --page-images --fallback-thumbnails --only-representative --only-missing-thumbnails

# Rebuild pipeline-generated thumbnails while preserving manual/curated thumbnails
python3 scripts/research_pipeline.py --input data/publications.json --output data/publications.json --enrich --download-pdfs --page-images --fallback-thumbnails --only-missing-thumbnails --refresh-auto-thumbnails --write
```

Configuration lives in `data/lab_members.json`. Add or update a member's `scholar_id` there to include them in Scholar collection. The script is dry-run by default and writes `data/publications.preview.json`; use `--write` only after reviewing the preview.

Enrichment options such as `--download-pdfs`, `--page-images`, and `--llm` require
`--enrich`. Preview and audit paths must be separate from the publication data and
member configuration. JSON output and downloaded PDFs use unique temporary files
beside their targets, then replace the targets atomically. The Scholar refresh
timestamp changes only when collection returns records; local audits and thumbnail
updates preserve it.

The pipeline can:
- collect publications from configured Google Scholar profile IDs
- merge and deduplicate publications by normalized title
- normalize lab-member ownership, categories, and site-facing records
- verify DOI/year/venue/link metadata with OpenAlex title matching
- apply manual overrides for records where Google Scholar omits venue/year metadata
- apply homepage promotion priorities through `PROMOTION_OVERRIDES` in `scripts/research_pipeline.py`
- write `data/publications.audit.json` with missing-field, duplicate, thumbnail, and policy checks
- find/download PDFs where available
- extract PDF text and score representative thumbnail images
- use landing-page images when PDF extraction is not useful
- generate consistent fallback cards when no suitable paper image is available
- infer categories from keywords
- optionally call an OpenAI-compatible chat completion API for concise summaries, tags, and category refinement

PDF caches and preview files are ignored by Git. Generated thumbnails under `images/publications/thumbnails/auto/` can be reviewed and committed when useful. Curated publication crops should live under `images/publications/manual_added/` and be pinned through `MANUAL_METADATA_OVERRIDES`.

### Paper demos

A publication can link to a live demo by setting `demo_url` on its record. Pin it in
`MANUAL_METADATA_OVERRIDES` in `scripts/research_pipeline.py` so a data refresh keeps it.
The homepage hero renders it as a "Live demo" button; the research list renders a "Demo" link.

## Deployment

Served by GitHub Pages from `main` at https://paetzold-lab.github.io/.
Push to `main` and Pages rebuilds; `web/index.html` keeps the legacy `/web/` URL redirecting to the root.

### Contact backend

`scripts/contact-form.gs` is the source for the separately deployed Google Apps
Script endpoint. Changing this repo does **not** update that deployment. Copy the
script into its existing Apps Script project and deploy a new version of the
**existing deployment**, following the setup comment at the top of the file.

Responses go into the `Responses` tab, which is created if absent; other tabs are
left untouched. Visitor input is stored as text, writes use a script lock, and
notification failures leave the saved submission intact. Notifications have a
persistent hourly budget of 25 recipients, including CC, and respect MailApp's
remaining daily recipient quota. The sheet retains submissions when mail is capped.

The static form sends a `text/plain` JSON POST with `mode: "cors"` to avoid a
preflight. It confirms receipt only after reading a positive `{ "ok": true }`
response; network errors and rejected responses preserve the entered message.
Keep both Google script hosts in the CSP's `connect-src` directive. A live
end-to-end delivery check also requires verifying the saved row and notification
in the owner's account.

## Checks

With Python dependencies installed and Node.js 22+ available:

```bash
node --test scripts/site-regression.test.cjs tests/*.test.cjs
python3 scripts/check-site.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
```

These checks run offline with mocked backend services. They cover contact
validation, spreadsheet formula injection, email budgets, concurrent/failed file
writes, interrupted PDF downloads, asset links, metadata, CSP, and publication data.

For real-browser checks on the cluster, install the isolated tools under the
exported `$TMPDIR` and remove them afterward:

```bash
check_dir=$(mktemp -d "$TMPDIR/lab-web-check.XXXXXX")
npm_config_cache="$check_dir/npm-cache" npm install --prefix "$check_dir/tools" --no-audit --no-fund playwright@1.64.1
export PLAYWRIGHT_BROWSERS_PATH="$check_dir/browsers"
"$check_dir/tools/node_modules/.bin/playwright" install chromium
NODE_PATH="$check_dir/tools/node_modules" node tests/browser-smoke.cjs
rm -rf -- "$check_dir"
unset PLAYWRIGHT_BROWSERS_PATH
```

The browser check serves the repo on loopback, checks all pages at desktop and
mobile widths, and tests search, dialogs, publication controls, failure handling,
and contact submission. External requests are intercepted, so no test email is
sent. `.github/workflows/checks.yml` runs these checks on pushes and pull requests;
it does not deploy the site or refresh publication data.

## Credits

- Matt Li
