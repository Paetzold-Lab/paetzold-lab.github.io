"""Check local links, metadata, security policy, and publication asset integrity."""
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import unittest
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://paetzold-lab.github.io"
PAGES = sorted([*(page for page in ROOT.glob("*.html") if page.name != "404.html"), *ROOT.glob("team_members_subpage/*.html")])


class Markup(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.elements = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))


class SiteTests(unittest.TestCase):
    def test_local_assets_links_and_fragments_resolve(self):
        for page in [*PAGES, ROOT / "404.html", *ROOT.glob("components/*.html")]:
            for tag, attrs in Markup(page.read_text()).elements:
                for key in ("href", "src"):
                    link = attrs.get(key, "")
                    parts = urlsplit(link)
                    if not link or parts.scheme or parts.netloc:
                        continue
                    # Shared fragments resolve their paths from the site root.
                    base = ROOT if page.parent.name == "components" else page.parent
                    target = (ROOT / parts.path.lstrip("/") if parts.path.startswith("/") else base / unquote(parts.path)) if parts.path else page
                    if not parts.path and page.parent.name == "components":
                        target = ROOT / "index.html"
                    if target.is_dir():
                        target /= "index.html"
                    with self.subTest(page=page.name, link=link):
                        self.assertTrue(target.is_file(), f"missing {target}")
                        if parts.fragment and target.suffix == ".html" and not parts.fragment.startswith(":~:"):
                            ids = {a.get("id") for _, a in Markup(target.read_text()).elements}
                            self.assertIn(unquote(parts.fragment), ids)

    def test_page_metadata_and_asset_versions_stay_consistent(self):
        version = re.search(r'const SITE_VERSION = "([^"]+)"', (ROOT / "js/site-utils.js").read_text()).group(1)
        for page in PAGES:
            elements = Markup(page.read_text()).elements
            attrs_by_id = [a["id"] for _, a in elements if "id" in a]
            with self.subTest(page=page.name):
                self.assertEqual(len(attrs_by_id), len(set(attrs_by_id)), "duplicate DOM IDs")
                self.assertIn("main-content", attrs_by_id)
                canonical = next(a["href"] for tag, a in elements if tag == "link" and a.get("rel") == "canonical")
                expected = ORIGIN + ("/" if page.name == "index.html" else "/" + page.relative_to(ROOT).as_posix())
                self.assertEqual(canonical, expected)
                self.assertTrue(any(tag == "meta" and a.get("name") == "description" and a.get("content") for tag, a in elements))
                for tag, a in elements:
                    if tag == "script" and a.get("src") or tag == "link" and a.get("rel") == "stylesheet":
                        self.assertEqual(urlsplit(a.get("src") or a["href"]).query, "v=" + version)
                    if a.get("target") == "_blank":
                        self.assertIn("noopener", a.get("rel", "").split())

    def test_content_security_policy_needs_no_inline_scripts(self):
        for page in PAGES:
            with self.subTest(page=page.name):
                elements = Markup(page.read_text()).elements
                policy = next(a["content"] for tag, a in elements if tag == "meta" and a.get("http-equiv", "").lower() == "content-security-policy")
                directives = dict((s.strip().split()[0], s.strip().split()[1:]) for s in policy.split(";") if s.strip())
                self.assertEqual(directives["script-src"], ["'self'"])
                self.assertIn("https://script.google.com", directives["connect-src"])
                self.assertIn("https://script.googleusercontent.com", directives["connect-src"])
                for tag, attrs in elements:
                    self.assertFalse(any(key.startswith("on") for key in attrs), "inline event handler")
                    if tag == "script" and not attrs.get("src"):
                        self.assertEqual(attrs.get("type"), "application/ld+json")
        for fragment in ROOT.glob("components/*.html"):
            self.assertFalse(any(tag == "script" for tag, _ in Markup(fragment.read_text()).elements))

    def test_sitemap_lists_each_canonical_page_once(self):
        urls = [node.text for node in ET.parse(ROOT / "sitemap.xml").findall("{*}url/{*}loc")]
        expected = {ORIGIN + ("/" if page.name == "index.html" else "/" + page.relative_to(ROOT).as_posix()) for page in PAGES}
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(set(urls), expected)

    def test_publications_have_valid_ids_lists_and_local_images(self):
        data = json.loads((ROOT / "data/publications.json").read_text())
        ids = [pub["id"] for pub in data["publications"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(ids)
        for pub in data["publications"]:
            with self.subTest(id=pub["id"]):
                self.assertTrue(pub["title"].strip())
                for key in ("categories", "source_members", "llm_tags"):
                    values = pub.get(key) or []
                    self.assertIsInstance(values, list)
                    self.assertTrue(all(isinstance(value, str) for value in values))
                self.assertTrue(set(pub.get("categories") or []) <= set(data["categories"]))
                image = pub.get("thumbnail") or "images/publications/default.png"
                self.assertFalse(urlsplit(image).scheme, "remote thumbnails are blocked by the site's CSP")
                self.assertTrue((ROOT / image.removeprefix("./")).is_file(), image)
        for source in (ROOT / "js").glob("*.js"):
            for image in re.findall(r'"(?:\./)?(images/[^"${}]+\.(?:jpg|jpeg|png))"', source.read_text()):
                self.assertTrue((ROOT / image).is_file(), image)

    def test_forms_match_backend_limits(self):
        for page in PAGES:
            elements = Markup(page.read_text()).elements
            if not any(a.get("id") == "contact-form" for _, a in elements):
                continue
            fields = {a.get("name"): a for tag, a in elements if tag in ("input", "textarea")}
            with self.subTest(page=page.name):
                for name, limit in (("name", "120"), ("email", "200"), ("message", "4000")):
                    self.assertEqual(fields[name]["maxlength"], limit)
                    self.assertIn("required", fields[name])
                self.assertEqual(fields["message"]["minlength"], "10")


if __name__ == "__main__":
    unittest.main()
