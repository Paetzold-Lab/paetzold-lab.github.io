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
│   ├── research_show/      # Research images
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

### Cache busting

Static assets are referenced as `?v=<token>`. When shipping CSS/JS changes, bump
`SITE_VERSION` in `js/site-utils.js` and the matching `?v=` token in every HTML page
(they must stay in sync).

## Development

### Adding Pages

Create new HTML files based on existing templates, including component placeholders and necessary CSS/JS references.

### Publication Management

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

## Credits

- Matt Li
