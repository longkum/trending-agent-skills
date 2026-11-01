#!/usr/bin/env python3
"""Incrementally collect GitHub's official privacy-safe star-history buckets.

The endpoint records *currently active* stars by creation day. Its counts are
NOT historical net Star changes: past unstar operations aren't represented.
See https://docs.github.com/en/rest/activity/starring#get-repository-star-history
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys
from urllib import request, error, parse

ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = "https://api.github.com/repos/{}/stargazers/history?per_page=6"
SCHEMA = 1
WINDOWS = (1, 7, 30)
LOOKBACK = 36
NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}\Z")


class HistoryError(ValueError):
    """Do not publish incomplete or malformed buckets as valid metrics."""


def normalized_date(value: str) -> date:
    try:
        d = date.fromisoformat(value)
        if d.isoformat() != value:
            raise ValueError(value)
        return d
    except (ValueError, TypeError) as exc:
        raise HistoryError(f"Invalid day: {value!r}") from exc


def normalize_buckets(buckets, collected_at: datetime, created_at: str):
    """Return last 30 completed calendar day values, or None if unsupported.

    The GitHub API documents that week/day boundaries are not necessarily UTC;
    dates below are labels for the API buckets, not exact UTC 24h intervals.
    """
    if not isinstance(buckets, list):
        raise HistoryError("Expected list of weekly Star counts")
    today = collected_at.astimezone(timezone.utc).date()
    end = today - timedelta(days=1)
    start = end - timedelta(days=29)
    creation = normalized_date(created_at)
    daily = {}
    for week in buckets:
        if not isinstance(week, dict):
            raise HistoryError("Invalid weekly Star bucket")
        timestamp, values, total = week.get("week"), week.get("days"), week.get("total")
        if type(timestamp) is not int or timestamp < 0 or not isinstance(values, list) or len(values) != 7:
            raise HistoryError("Invalid week or day array")
        if any(type(x) is not int or x < 0 for x in values):
            raise HistoryError("Negative or noninteger day count")
        if type(total) is not int or total != sum(values):
            raise HistoryError("Week total differs from summed days")
        week_start = datetime.fromtimestamp(timestamp, timezone.utc).date()
        # GitHub documents that week/day boundaries may not align with UTC.
        # A local Sunday bucket can fall on UTC Saturday or Monday; normalize
        # only that one-day timezone offset, not an arbitrary malformed week.
        if week_start.weekday() == 5:
            week_start += timedelta(days=1)
        elif week_start.weekday() == 0:
            week_start -= timedelta(days=1)
        elif week_start.weekday() != 6:
            raise HistoryError("Week start is not close to Sunday")
        for i, count in enumerate(values):
            d = week_start + timedelta(days=i)
            if d in daily and daily[d] != count:
                raise HistoryError("Conflicting overlapping weeks")
            daily[d] = count
    daily_values = []
    for i in range(30):
        d = start + timedelta(days=i)
        if d < creation:
            n = 0   # A repository cannot receive Stars before it exists.
        elif d in daily:
            n = daily[d]
        else:
            # Do not replace unavailable history with fabricated zero counts.
            return None
        daily_values.append([d.isoformat(), n])
    return daily_values


def make_windows(daily_values: list, stars: int):
    if type(stars) is not int or stars < 0:
        raise HistoryError("Invalid current total Stars")
    if len(daily_values) != 30:
        raise HistoryError("Expected 30 complete calendar days")
    windows = {}
    for days in WINDOWS:
        new_stars = sum(p[1] for p in daily_values[-days:])
        baseline = stars - new_stars
        windows[str(days)] = {
            "delta": new_stars,
            "baseline": baseline if baseline >= 0 else None,
            "rate": round(new_stars * 100 / baseline, 4) if baseline > 0 else None,
            "rate_rankable": baseline >= 10,
        }
    return windows


def fetch_history(name, token, opener=request.urlopen):
    if not NAME_RE.fullmatch(name) or name.split("/")[1] in (".", ".."):
        raise HistoryError("Invalid repository name")
    uri = ENDPOINT.format('/'.join(parse.quote(p, safe='') for p in name.split('/')))
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "trending-agent-skills-star-history",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    req = request.Request(uri, headers=headers)
    with opener(req, timeout=25) as response:
        return json.loads(response.read().decode("utf-8"))


def prioritize(catalog, existing):
    rows = existing.get("records", {})
    def key(item):
        name, record = item
        previous = rows.get(name) or {}
        sampled = previous.get("collected_at") or ""
        gain = record.get("gain_7d", 0)
        stars = record.get("stars", 0)
        return (bool(sampled), sampled, -max(gain, 0) if type(gain) is int else 0,
                -stars if type(stars) is int else 0, name.lower())
    return [name for name, _ in sorted(catalog.items(), key=key)]


def collect(catalog, old, verified, token, now, limit=650, workers=5, fetch=fetch_history):
    """Produce a truthful partial cache for a bounded, rate-limit-safe batch."""
    if not isinstance(catalog, dict) or not catalog:
        raise HistoryError("Empty catalog")
    if not isinstance(old, dict) or old.get("schema") != SCHEMA or not isinstance(old.get("records"), dict):
        raise HistoryError("Invalid previous cache")
    verified = verified if isinstance(verified, dict) else {}
    result = dict(old["records"])
    attempted = 0
    succeeded = 0
    failures = []
    eligible = prioritize(catalog, old)[:limit]
    updated_at = now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

    def download(name):
        item = catalog[name]
        buckets = fetch(name, token)
        days = normalize_buckets(buckets, now, item["created_at"])
        if days is None:
            raise HistoryError("History missing at least one day in 30-day window")
        observation = verified.get(name, {})
        stars = observation.get("stars", item.get("stars"))
        if type(stars) is not int or stars < 0:
            raise HistoryError("Unknown latest Star count")
        return name, {
            "collected_at": updated_at,
            "window_end": days[-1][0],
            "stars": stars,
            "days": days,
            "windows": make_windows(days, stars),
            "source": "github-rest-star-history",
        }

    with ThreadPoolExecutor(max_workers=max(1, min(workers, 8))) as pool:
        futures = {pool.submit(download, name): name for name in eligible}
        for task in as_completed(futures):
            attempted += 1
            name = futures[task]
            try:
                actual_name, payload = task.result()
                result[actual_name] = payload
                succeeded += 1
            except (error.HTTPError, error.URLError, TimeoutError, ValueError, OSError) as exc:
                failures.append([name, str(exc)[:200]])
    if eligible and succeeded == 0:
        raise HistoryError("No valid official Star history response; refusing empty update. " + str(failures[:3]))
    # A versioned cache, rather than silently blending it into net-growth data.
    coverage = sum(name in result for name in catalog)
    fresh_day = now.astimezone(timezone.utc).date() - timedelta(days=1)
    fresh = sum(name in catalog and row.get("window_end") == fresh_day.isoformat()
                for name, row in result.items())
    return {
        "schema": SCHEMA,
        "source": "github-rest-star-history",
        "method": "currently-active-stars-created-on-each-calendar-day",
        "updated_at": updated_at,
        "coverage": {"total": len(catalog), "sampled": coverage, "fresh": fresh},
        "records": result,
    }, {"attempted": attempted, "succeeded": succeeded, "failures": failures}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=650)
    parser.add_argument("--workers", type=int, default=5)
    args = parser.parse_args(argv)
    if not (1 <= args.limit <= 900):
        parser.error("--limit must be between 1 and 900")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        raise SystemExit("GITHUB_TOKEN is required to collect in CI")
    catalog = json.loads((ROOT / "data/repos.json").read_text(encoding="utf-8"))
    cache_file = ROOT / "data/star-activity.json"
    if cache_file.exists():
        old = json.loads(cache_file.read_text(encoding="utf-8"))
    else:
        old = {"schema": SCHEMA, "records": {}}
    verified_file = ROOT / "data/star-growth.json"
    verified = json.loads(verified_file.read_text(encoding="utf-8")).get("records", {}) if verified_file.exists() else {}
    payload, stats = collect(catalog, old, verified, token, datetime.now(timezone.utc),
                             args.limit, args.workers)
    temp = cache_file.with_suffix(".json.tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(cache_file)
    print(f"GitHub Star History: {stats['succeeded']}/{stats['attempted']} updated, "
          f"{payload['coverage']['sampled']}/{payload['coverage']['total']} covered, "
          f"{payload['coverage']['fresh']} fresh")
    for name, description in stats["failures"][:20]:
        print(f"  {name}: {description}", file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except (HistoryError, OSError, ValueError) as exc:
        raise SystemExit(f"Star history retrieval failed: {exc}")