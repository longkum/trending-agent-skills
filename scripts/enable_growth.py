#!/usr/bin/env python3
"""Idempotently integrate the Star leaderboard into an existing catalog checkout.

Apply only to the audited static catalog version. This refuses unfamiliar source
layout rather than replacing the user's other changes.
"""
from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if text.count(old) != 1:
        raise RuntimeError(f"Unexpected {label} structure: expected one integration point, found {text.count(old)}")
    return text.replace(old, new, 1)


def integrate(root: Path = ROOT) -> None:
    build_path = root / 'scripts' / 'build.py'
    template_path = root / 'src' / 'index.template.html'
    build = build_path.read_text(encoding='utf-8')
    template = template_path.read_text(encoding='utf-8')
    build = replace_once(
        build,
        'for filename in ("radix.css", "styles.css")',
        'for filename in ("radix.css", "styles.css", "growth.css")',
        'CSS generator sources',
    )
    build = replace_once(
        build,
        'for filename in ("catalog-core.js", "app.js")',
        'for filename in ("catalog-core.js", "app.js", "growth-core.js", "growth-app.js")',
        'JavaScript generator sources',
    )
    # Source repo data remains intact. The published HTML adopts the latest
    # *verified* snapshot values only for repositories successfully sampled.
    marker = '    source = root / "src"\n'
    injected = '''    growth_path = root / "data" / "star-growth.json"
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
'''
    build = replace_once(build, marker, injected, 'growth data publisher')
    nav_marker = '      <div class="nav-links">\n'
    nav_addition = '''      <div class="nav-links">
        <a href="#growth">涨星榜</a>
'''
    template = replace_once(template, nav_marker, nav_addition, 'navigation')
    section = (root / 'src' / 'growth-section.html').read_text(encoding='utf-8')
    catalog_anchor = '      <section class="catalog" id="catalog"'
    template = replace_once(template, catalog_anchor, section + '\n' + catalog_anchor, 'catalog section')
    test_path = root / 'tests' / 'test_build.py'
    test_contents = None
    if test_path.exists():
        test_contents = test_path.read_text(encoding='utf-8')
        test_contents = replace_once(
            test_contents,
            '("radix.css", "styles.css", "catalog-core.js", "app.js")',
            '("radix.css", "styles.css", "growth.css", "catalog-core.js", "app.js", "growth-core.js", "growth-app.js")',
            'temporary test fixture sources',
        )
    # Write only after every check succeeds. A second invocation is a no-op.
    build_path.write_text(build, encoding='utf-8')
    template_path.write_text(template, encoding='utf-8')
    if test_contents is not None:
        test_path.write_text(test_contents, encoding='utf-8')


if __name__ == '__main__':
    try:
        integrate()
        print('Star leaderboard sources integrated. Run growth_metrics.py then build.py.')
    except (RuntimeError, OSError) as exc:
        sys.exit(f'Cannot integrate safely: {exc}')
