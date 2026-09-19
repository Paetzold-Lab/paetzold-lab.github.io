"""Check site links, page metadata, cache tokens and publication assets (stdlib only)."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
import re

ROOT = Path(__file__).resolve().parent.parent
VERSION = re.search(r'const SITE_VERSION = "([^"]+)"', (ROOT / 'js/site-utils.js').read_text())[1]
errors = []

class Page(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.tags = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

paths = sorted(ROOT.glob('*.html')) + sorted(ROOT.glob('team_members_subpage/*.html'))
pages = {path: Page(path.read_text()) for path in paths}
for path, page in pages.items():
    label = str(path.relative_to(ROOT))
    ids = Counter(attrs['id'] for _, attrs in page.tags if 'id' in attrs)
    if any(count > 1 for count in ids.values()):
        errors.append(f'{label}: duplicate IDs')
    if sum(tag == 'h1' for tag, _ in page.tags) != 1:
        errors.append(f'{label}: expected one static h1')
    metas = {attrs.get('name'): attrs.get('content') for tag, attrs in page.tags if tag == 'meta'}
    if 'viewport' not in metas:
        errors.append(f'{label}: missing viewport')
    if path.name != '404.html' and 'description' not in metas:
        errors.append(f'{label}: missing description')
    for tag, attrs in page.tags:
        for attr in ('src', 'href'):
            raw = attrs.get(attr, '')
            url = urlsplit(raw)
            if not raw or url.scheme or url.netloc:
                continue
            target = (ROOT / unquote(url.path).lstrip('/') if url.path.startswith('/') else path.parent / unquote(url.path)).resolve() if url.path else path
            if not target.exists():
                errors.append(f'{label}: missing {raw}')
            elif url.fragment and target in pages and not any(a.get('id') == url.fragment for _, a in pages[target].tags):
                errors.append(f'{label}: missing anchor {raw}')
            if url.path.endswith(('.css', '.js')) and url.query != f'v={VERSION}':
                errors.append(f'{label}: stale cache token {raw}')
        if tag == 'img' and not all(attr in attrs for attr in ('alt', 'width', 'height')):
            errors.append(f'{label}: image needs alt text and dimensions: {attrs.get("src")}')
        if attrs.get('target') == '_blank' and 'noopener' not in attrs.get('rel', ''):
            errors.append(f'{label}: unsafe new-tab link')
        if tag in ('input', 'textarea') and attrs.get('name') in ('name', 'email', 'message') and 'maxlength' not in attrs:
            errors.append(f'{label}: unlimited form field {attrs["name"]}')

records = json.loads((ROOT / 'data/publications.json').read_text())['publications']
if len({p['id'] for p in records}) != len(records):
    errors.append('Duplicate publication IDs')
for publication in records:
    if not publication.get('title'):
        errors.append(f'{publication["id"]}: missing title')
    thumbnail = publication.get('thumbnail')
    if thumbnail and not urlsplit(thumbnail).scheme and not (ROOT / thumbnail).is_file():
        errors.append(f'{publication["id"]}: missing thumbnail {thumbnail}')

if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: {len(pages)} pages, local links and anchors, metadata, image dimensions, cache tokens, form constraints, and {len(records)} publication records.')
