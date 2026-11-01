#!/usr/bin/env python3
"""Build the standalone catalog from its original data and editable sources."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import date
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
# Keep this contract aligned with CatalogCore.safeRepoUrl: owners have 1–39
# characters and alphanumeric endpoints; repository names have 1–100
# characters and may not be the URL path segments "." or "..".
NAME_RE = re.compile(
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}\Z"
)
PLACEHOLDER_RE = re.compile(r"\{\{([A-Z_]+)\}\}")
DATE_FIELDS = ("created_at", "first_seen", "last_refreshed")
TEXT_FIELDS = ("summary", "summary_en", "description")
# Domain categories for the catalog filter. Keep in sync with
# ~/workspace/goals/github-skills-ai/hidden_files/classify.py CATEGORIES.
CATEGORIES = (
    ("finance", "金融交易"),
    ("security", "安全攻防"),
    ("media", "音视频语音"),
    ("design", "设计创意"),
    ("mcp", "MCP 生态"),
    ("marketing", "营销内容"),
    ("rag", "RAG 与知识库"),
    ("crawl", "搜索与采集"),
    ("assistant", "对话与助手"),
    ("coding", "AI 编程"),
    ("agent", "Agent 框架与工作流"),
    ("models", "模型与推理"),
    ("data", "数据分析"),
    ("learn", "学习与合集"),
    ("productivity", "效率办公"),
    ("devops", "开发运维"),
    ("skills", "Skills 通用"),
    ("game", "游戏"),
    ("other", "其他"),
)
CATEGORY_IDS = frozenset(cid for cid, _ in CATEGORIES)


class BuildError(ValueError):
    """An input cannot be published without changing its meaning."""


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BuildError(f"Duplicate JSON key: {key!r}")
        result[key] = value
    return result


def load_catalog(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"),
                          object_pairs_hook=reject_duplicate_keys)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise BuildError(f"Cannot read catalog JSON: {error}") from error


def validate_repo_url(name: str, value: object) -> str:
    if not isinstance(value, str):
        raise BuildError(f"{name}: url must be a string")
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise BuildError(f"{name}: invalid repository URL") from error
    if (parsed.scheme != "https" or parsed.netloc != "github.com"
            or parsed.path != "/" + name or parsed.query or parsed.fragment
            or value != f"https://github.com/{name}"):
        raise BuildError(f"{name}: url must be https://github.com/{name}")
    return value


def prepare_catalog(source: object) -> tuple[dict, dict]:
    """Validate every record; compact repeated text without rewriting the data."""
    if not isinstance(source, dict) or not source:
        raise BuildError("Catalog must be a non-empty object keyed by owner/repository")
    records = []
    for name in sorted(source):
        if (not isinstance(name, str) or not NAME_RE.fullmatch(name)
                or name.split("/")[1] in (".", "..")):
            raise BuildError(f"Invalid repository name: {name!r}")
        item = source[name]
        if not isinstance(item, dict):
            raise BuildError(f"{name}: record must be an object")
        track = item.get("track")
        if track not in ("skills", "ai"):
            raise BuildError(f"{name}: track must be skills or ai")
        category = item.get("category")
        if category not in CATEGORY_IDS:
            raise BuildError(f"{name}: category must be one of {sorted(CATEGORY_IDS)}")
        stars = item.get("stars")
        if isinstance(stars, bool) or not isinstance(stars, int) or stars < 0:
            raise BuildError(f"{name}: stars must be a non-negative integer")
        gain_7d = item.get("gain_7d", 0)
        if isinstance(gain_7d, bool) or not isinstance(gain_7d, int):
            raise BuildError(f"{name}: gain_7d must be an integer")
        record = {"name": name, "url": validate_repo_url(name, item.get("url")),
                  "track": track, "stars": stars, "category": category,
                  "gain_7d": gain_7d}
        for field in DATE_FIELDS:
            value = item.get(field)
            if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise BuildError(f"{name}: {field} must be a YYYY-MM-DD date")
            try:
                date.fromisoformat(value)
            except ValueError as error:
                raise BuildError(f"{name}: invalid {field}: {value!r}") from error
            record[field] = value
        for field in TEXT_FIELDS:
            value = item.get(field, "")
            if not isinstance(value, str):
                raise BuildError(f"{name}: {field} must be a string")
            record[field] = value
        # Search and display still see the same text through summary. Keep
        # distinct translations/descriptions, including non-empty fallbacks.
        for field in ("summary_en", "description"):
            if record[field] == record["summary"]:
                del record[field]
        records.append(record)

    updated = max(record["last_refreshed"] for record in records)
    tracks = Counter(record["track"] for record in records)
    cats = Counter(record["category"] for record in records)
    stats = {
        "TOTAL": f"{len(records):,}",
        "SKILLS": f"{tracks['skills']:,}",
        "AI": f"{tracks['ai']:,}",
        "STARS": f"{sum(record['stars'] for record in records):,}",
        "UPDATED": updated,
        "NEW_COUNT": f"{sum(record['first_seen'] == updated for record in records):,}",
    }
    names = dict(CATEGORIES)
    categories = [{"id": cid, "name": names[cid], "count": cats[cid]}
                  for cid, _ in sorted(CATEGORIES, key=lambda c: (c[0] == "other", -cats[c[0]], c[1]))]
    return {"updated": updated, "records": records, "categories": categories}, stats


def inline_json(value: object) -> str:
    """JSON data is not JavaScript: prevent its HTML script tag from closing."""
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return (serialized.replace("&", "\\u0026").replace("<", "\\u003c")
            .replace(">", "\\u003e").replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


def render(root: Path = ROOT) -> tuple[str, int]:
    payload, values = prepare_catalog(load_catalog(root / "data" / "repos.json"))
    growth_path = root / "data" / "star-growth.json"
    if growth_path.exists():
        growth = json.loads(growth_path.read_text(encoding="utf-8"))
        if growth.get("schema") != 1 or not isinstance(growth.get("records"), dict):
            raise BuildError("Invalid Star growth data")
        for record in payload["records"]:
            metric = growth["records"].get(record["name"])
            if not metric:
                continue
            if type(metric.get("stars")) is not int or metric["stars"] < 0:
                raise BuildError("Invalid verified Star count: " + record["name"])
            record["stars"] = metric["stars"]
            record["last_refreshed"] = metric["as_of"][:10]
            value = metric.get("windows", {}).get("7")
            if value and type(value.get("delta")) is int:
                record["gain_7d"] = value["delta"]
        values["STARS"] = f"{sum(record['stars'] for record in payload['records']):,}"
        values["UPDATED"] = max(record["last_refreshed"] for record in payload["records"])
        payload["updated"] = values["UPDATED"]
        values["NEW_COUNT"] = f"{sum(record['first_seen'] == values['UPDATED'] for record in payload['records']):,}"
    source = root / "src"
    template = (source / "index.template.html").read_text(encoding="utf-8")
    present = set(PLACEHOLDER_RE.findall(template))
    missing = {"STYLES", "SCRIPTS", "DATA"} - present
    if missing:
        raise BuildError("Template is missing: " + ", ".join(sorted(missing)))
    styles = "\n\n".join((source / filename).read_text(encoding="utf-8")
                         for filename in ("radix.css", "styles.css", "growth.css"))
    scripts = "\n;\n".join((source / filename).read_text(encoding="utf-8")
                          for filename in ("catalog-core.js", "app.js", "growth-core.js", "star-activity-core.js", "growth-app.js"))
    if re.search(r"</style\b", styles, re.I) or re.search(r"</script\b", scripts, re.I):
        raise BuildError("Inline source contains an HTML closing style/script tag")
    values.update(STYLES=styles, SCRIPTS=scripts, DATA=inline_json(payload))

    def replace(match):
        key = match.group(1)
        if key not in values:
            raise BuildError(f"Unknown template placeholder: {key}")
        return values[key]

    # A single substitution pass prevents content in a repository summary from
    # becoming an accidental template instruction.
    html = PLACEHOLDER_RE.sub(replace, template)
    return html, len(payload["records"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="fail if index.html does not match current source/data")
    args = parser.parse_args(argv)
    try:
        html, count = render()
        content = html.encode("utf-8")
        target = ROOT / "index.html"
        if args.check:
            if not target.exists() or target.read_bytes() != content:
                print("index.html is out of date; run python3 scripts/build.py", file=sys.stderr)
                return 1
            print(f"Verified index.html: {count:,} repositories, {len(content):,} bytes")
            return 0
        temporary = target.with_name(".index.html.tmp")
        temporary.write_bytes(content)
        temporary.replace(target)
        print(f"Built index.html: {count:,} repositories, {len(content):,} bytes")
        return 0
    except (BuildError, OSError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
