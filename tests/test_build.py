"""Publication-boundary checks for the static catalog generator."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("catalog_build", ROOT / "scripts" / "build.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


def record(name="example/repo", **changes):
    value = {
        "url": "https://github.com/" + name, "track": "skills", "stars": 42,
        "category": "coding",
        "created_at": "2026-01-01", "first_seen": "2026-10-27",
        "last_refreshed": "2026-10-28", "summary": "摘要",
        "summary_en": "Summary", "description": "Description",
    }
    value.update(changes)
    return value


class BuildTests(unittest.TestCase):
    def test_embedded_data_cannot_escape_script_and_round_trips(self):
        hostile = '</script><script>alert("x")</script>&\u2028\u2029{{TOTAL}}'
        payload, _ = build.prepare_catalog({"example/repo": record(summary=hostile)})
        serialized = build.inline_json(payload)
        self.assertNotIn("<", serialized)
        self.assertNotIn(">", serialized)
        self.assertNotIn("&", serialized)
        self.assertNotIn("\u2028", serialized)
        self.assertNotIn("\u2029", serialized)
        self.assertEqual(json.loads(serialized), payload)

    def test_compaction_preserves_distinct_text_and_missing_summary(self):
        source = {
            "example/identical": record("example/identical", summary="same", summary_en="same", description="same"),
            "example/fallback": record("example/fallback", summary="", description="Actual description"),
            "example/empty": record("example/empty", summary="", summary_en="", description=""),
        }
        before = copy.deepcopy(source)
        payload, _ = build.prepare_catalog(source)
        by_name = {item["name"]: item for item in payload["records"]}
        self.assertEqual(source, before)
        self.assertEqual(set(by_name), set(source))
        self.assertNotIn("summary_en", by_name["example/identical"])
        self.assertNotIn("description", by_name["example/identical"])
        self.assertEqual(by_name["example/fallback"]["description"], "Actual description")
        self.assertEqual(by_name["example/fallback"]["summary_en"], "Summary")
        self.assertEqual(by_name["example/empty"]["summary"], "")

    def test_invalid_records_fail_instead_of_disappearing(self):
        invalid = [
            {"url": "javascript:alert(1)"},
            {"url": "https://github.com.evil.test/example/repo"},
            {"url": "https://user:pass@github.com/example/repo"},
            {"url": "https://github.com/other/repo"},
            {"created_at": "2026-02-30"}, {"track": "unknown"},
            {"stars": True}, {"stars": -1}, {"summary": ["not text"]},
            {"category": "unknown"}, {"category": ""}, {"category": None},
        ]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(build.BuildError):
                build.prepare_catalog({"example/repo": record(**changes)})
        # A missing category key is also rejected: every published record
        # must carry its domain category.
        source = {"example/repo": record()}
        del source["example/repo"]["category"]
        with self.assertRaises(build.BuildError):
            build.prepare_catalog(source)

    def test_categories_are_validated_and_reported_with_counts(self):
        source = {
            "example/one": record("example/one", category="coding"),
            "example/two": record("example/two", category="other"),
        }
        payload, _ = build.prepare_catalog(source)
        by_id = {item["id"]: item for item in payload["categories"]}
        self.assertEqual(by_id["coding"]["count"], 1)
        self.assertEqual(by_id["coding"]["name"], "AI 编程")
        self.assertEqual(by_id["other"]["count"], 1)
        self.assertEqual(len(payload["categories"]), len(build.CATEGORIES))
        # Sorted by count descending.
        counts = [item["count"] for item in payload["categories"]]
        self.assertEqual(counts, sorted(counts, reverse=True))
        self.assertEqual(payload["records"][0]["category"], "coding")

    def test_names_rejected_by_runtime_are_rejected_before_publication(self):
        # These previously passed the build and caused the entire browser
        # catalog to enter its error state when safeRepoUrl rejected them.
        invalid_names = ["x-/r", "-x/r", "org/.", "org/..",
                         "a" * 40 + "/r", "org/" + "r" * 101]
        for name in invalid_names:
            with self.subTest(name=name), self.assertRaises(build.BuildError):
                build.prepare_catalog({name: record(name)})

        # Both endpoint lengths remain usable, including an internal hyphen.
        valid_names = ["x/r", "a-b/repo.name_1-2", "a" * 39 + "/" + "r" * 100]
        for name in valid_names:
            with self.subTest(name=name):
                payload, _ = build.prepare_catalog({name: record(name)})
                self.assertEqual(payload["records"][0]["name"], name)

    def test_template_tokens_inside_repository_text_are_not_interpreted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            (root / "src").mkdir()
            (root / "data" / "repos.json").write_text(json.dumps({
                "example/repo": record(summary="{{TOTAL}} is literal repository text")
            }), encoding="utf-8")
            (root / "src" / "index.template.html").write_text(
                '<style>{{STYLES}}</style><p>{{TOTAL}}</p><script type="application/json">{{DATA}}</script><script>{{SCRIPTS}}</script>',
                encoding="utf-8")
            for filename in ("radix.css", "styles.css", "catalog-core.js", "app.js"):
                (root / "src" / filename).write_text("", encoding="utf-8")
            html, count = build.render(root)
            self.assertEqual(count, 1)
            self.assertIn("<p>1</p>", html)
            self.assertIn("{{TOTAL}} is literal repository text", html)

    def test_real_catalog_preserves_every_record_without_touching_source(self):
        path = ROOT / "data" / "repos.json"
        before_bytes = path.read_bytes()
        source = build.load_catalog(path)
        payload, stats = build.prepare_catalog(source)
        self.assertEqual(len(payload["records"]), len(source))
        self.assertEqual([item["name"] for item in payload["records"]], sorted(source))
        self.assertEqual(sum(item["stars"] for item in payload["records"]),
                         sum(item["stars"] for item in source.values()))
        for item in payload["records"]:
            original = source[item["name"]]
            for field in ("url", "track", "stars", *build.DATE_FIELDS, "summary"):
                self.assertEqual(item[field], original[field])
            for field in ("summary_en", "description"):
                self.assertEqual(item.get(field, item["summary"]), original[field])
        self.assertEqual(stats["UPDATED"], max(item["last_refreshed"] for item in source.values()))
        self.assertEqual(path.read_bytes(), before_bytes)


if __name__ == "__main__":
    unittest.main()
