"""Offline regression checks for publication output and download integrity."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import research_pipeline as pipeline


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lab-web-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def response(self, chunks):
        response = MagicMock()
        response.__enter__.return_value = response
        response.iter_content.return_value = iter(chunks)
        return response

    def test_atomic_write_preserves_old_data_on_serialization_failure(self):
        path = self.root / "publications.json"
        path.write_text('{"original": true}\n')
        with self.assertRaises(ValueError):
            pipeline.write_json_atomic(path, {"bad": float("nan")})
        self.assertEqual(json.loads(path.read_text()), {"original": True})
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_concurrent_atomic_writes_produce_one_complete_document(self):
        path = self.root / "publications.json"
        path.write_text("{}")
        path.chmod(0o640)
        def write(index):
            pipeline.write_json_atomic(path, {"index": index, "values": [index] * 1000})
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(write, range(20)))
        data = json.loads(path.read_text())
        self.assertEqual(data["values"], [data["index"]] * 1000)
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_corrupt_nonempty_pdf_cache_is_replaced(self):
        path = self.root / "paper.pdf"
        path.write_bytes(b"<html>rate limited</html>")
        with patch.object(pipeline.requests, "get", return_value=self.response([b"%PDF-1.7\nbody\n%%EOF"])) as get:
            self.assertTrue(pipeline.download_pdf("https://example.org/paper.pdf", path))
            get.assert_called_once()
        self.assertTrue(path.read_bytes().startswith(b"%PDF-"))
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_legacy_truncated_pdf_cache_is_not_reused(self):
        path = self.root / "paper.pdf"
        path.write_bytes(b"%PDF-1.7\ninterrupted download")
        with patch.object(pipeline.requests, "get", return_value=self.response([b"%PDF-1.7\ncomplete\n%%EOF"])) as get:
            self.assertTrue(pipeline.download_pdf("https://example.org/paper.pdf", path))
            get.assert_called_once()
        self.assertTrue(path.read_bytes().endswith(b"%%EOF"))

    def test_valid_cache_does_not_make_network_requests(self):
        path = self.root / "paper.pdf"
        path.write_bytes(b"%PDF-1.7\nbody\n%%EOF")
        with patch.object(pipeline.requests, "get") as get:
            self.assertTrue(pipeline.download_pdf("https://example.org/paper.pdf", path))
            get.assert_not_called()

    def test_interrupted_pdf_download_never_installs_partial_cache(self):
        path = self.root / "paper.pdf"
        def interrupted():
            yield b"%PDF-1.7\npartial"
            raise pipeline.requests.ConnectionError("connection interrupted")
        response = self.response([])
        response.iter_content.return_value = interrupted()
        with patch.object(pipeline.requests, "get", return_value=response), redirect_stderr(io.StringIO()):
            self.assertFalse(pipeline.download_pdf("https://example.org/paper.pdf", path))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_invalid_empty_and_oversized_downloads_leave_no_cache(self):
        for chunks in ([], [b"<html>not a PDF</html>"], [b"%PDF-" + b"x" * 50]):
            with self.subTest(chunks=chunks), patch.object(pipeline, "MAX_PDF_BYTES", 40), \
                    patch.object(pipeline.requests, "get", return_value=self.response(chunks)), \
                    redirect_stderr(io.StringIO()):
                self.assertFalse(pipeline.download_pdf("https://example.org/paper.pdf", self.root / "paper.pdf"))
                self.assertEqual(list(self.root.iterdir()), [])

    def test_local_work_preserves_scholar_refresh_timestamp(self):
        source = {"last_updated": "2026-08-29T12:00:00+00:00"}
        output = pipeline.build_output(source, [], config={})
        self.assertEqual(output["last_updated"], source["last_updated"])
        refreshed = pipeline.build_output(source, [], config={}, scholar_refreshed=True)
        self.assertNotEqual(refreshed["last_updated"], source["last_updated"])

    def test_audit_detects_identical_duplicate_titles(self):
        report = pipeline.audit_publications([{"title": "Same title"}] * 2, members=[], allowed_categories={})
        self.assertEqual(report["summary"]["duplicate_title_groups"], 1)

    def test_cli_rejects_unsafe_paths_and_invalid_options(self):
        for options in (
            ["--audit", "--preview-output", str(pipeline.DEFAULT_INPUT)],
            ["--audit", "--audit-output", str(pipeline.DEFAULT_INPUT)],
            ["--audit", "--write", "--output", str(pipeline.DEFAULT_CONFIG)],
            ["--download-pdfs"], ["--llm"], ["--page-images"],
            ["--limit", "-1"], ["--max-pages", "0"], ["--page-size", "101"],
            ["--request-delay", "-1"], ["--request-delay", "nan"],
        ):
            with self.subTest(options=options), patch.object(sys, "argv", ["pipeline", *options]), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as exit:
                    pipeline.parse_args()
                self.assertEqual(exit.exception.code, 2)

    def test_default_preview_and_explicit_write_are_allowed(self):
        for options in (["--audit"], ["--normalize", "--write"]):
            with patch.object(sys, "argv", ["pipeline", *options]):
                pipeline.parse_args()


if __name__ == "__main__":
    unittest.main()
