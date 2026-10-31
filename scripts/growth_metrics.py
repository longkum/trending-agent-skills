#!/usr/bin/env python3
"""Compile independently collected GitHub Star snapshots into honest growth metrics."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re

REPO_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}\Z")
DAYS = (1, 7, 30)
MIN_BASE_STARS_FOR_RATE_RANK = 10


class GrowthDataError(ValueError):
    pass


def utc(value: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise GrowthDataError("collected_at must be an ISO UTC timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise GrowthDataError(f"invalid collected_at: {value}") from error
    if result.utcoffset() != timedelta(0):
        raise GrowthDataError("timestamp must be UTC")
    return result


def read_snapshots(directory: Path) -> list[dict]:
    if not directory.exists():
        return []
    snapshots = []
    for file in sorted(directory.glob("*.json")):
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", file.name):
            raise GrowthDataError(f"unrecognized snapshot filename: {file.name}")
        try:
            snapshot = json.loads(file.read_text(encoding="utf-8"))
        except (UnicodeError, ValueError) as error:
            raise GrowthDataError(f"invalid JSON in {file}") from error
        if not isinstance(snapshot, dict) or snapshot.get("schema") != 1:
            raise GrowthDataError(f"unsupported schema in {file}")
        at = utc(snapshot.get("collected_at"))
        day = file.stem
        if at.date().isoformat() != day:
            raise GrowthDataError(f"snapshot date mismatch: {file}")
        repos = snapshot.get("repositories")
        aliases = snapshot.get("aliases")
        if not isinstance(repos, dict) or not isinstance(aliases, dict):
            raise GrowthDataError(f"invalid repositories/aliases in {file}")
        for key, value in repos.items():
            if not isinstance(key, str) or not key.isdecimal() or not isinstance(value, dict):
                raise GrowthDataError(f"invalid repository ID in {file}")
            if (not REPO_RE.fullmatch(str(value.get("name", "")))
                or isinstance(value.get("stars"), bool)
                or not isinstance(value.get("stars"), int)
                or value["stars"] < 0):
                raise GrowthDataError(f"invalid repository record {key} in {file}")
        for alias, repo_id in aliases.items():
            if not REPO_RE.fullmatch(alias) or str(repo_id) not in repos:
                raise GrowthDataError(f"invalid alias {alias} in {file}")
        snapshots.append({"day": day, "at": at, "repos": repos, "aliases": aliases})
    return snapshots


def compile_metrics(catalog: dict, snapshots: list[dict]) -> dict:
    if not isinstance(catalog, dict):
        raise GrowthDataError("catalog must be an object")
    if not snapshots:
        return {"schema": 1, "as_of": None, "snapshot_days": 0,
                "coverage": {"total": len(catalog), "collected": 0}, "records": {}}
    snapshots = sorted(snapshots, key=lambda row: row["at"])
    if len(set(row["day"] for row in snapshots)) != len(snapshots):
        raise GrowthDataError("multiple snapshots for the same UTC day")
    latest = snapshots[-1]
    latest_date = latest["at"]
    # Track stable GitHub repository IDs rather than names across renames.
    known_aliases = {}
    for row in snapshots:
        for alias, repo_id in row["aliases"].items():
            known_aliases[alias.casefold()] = str(repo_id)
        for repo_id, info in row["repos"].items():
            known_aliases[info["name"].casefold()] = str(repo_id)
    historical = {}
    for row in snapshots:
        for repo_id, info in row["repos"].items():
            historical.setdefault(str(repo_id), []).append((row["at"], info["stars"]))

    records = {}
    for catalog_name in catalog:
        repo_id = known_aliases.get(catalog_name.casefold())
        if not repo_id or repo_id not in latest["repos"]:
            continue  # missing on latest day is not a zero or a ranked growth result
        current = latest["repos"][repo_id]
        points = historical[repo_id]
        windows = {}
        for days in DAYS:
            previous_day = (latest_date - timedelta(days=days)).date().isoformat()
            baseline = next(((at, stars) for at, stars in reversed(points)
                             if at.date().isoformat() == previous_day), None)
            if baseline is None:
                windows[str(days)] = None
                continue
            at, stars = baseline
            elapsed = (latest_date - at).total_seconds()
            # Keep the same scheduled hour: a very delayed run is not a
            # comparably measured 24-hour/7-day/30-day window.
            tolerance = 3 * 3600 if days == 1 else 6 * 3600
            if abs(elapsed - days * 86400) > tolerance:
                windows[str(days)] = None
                continue
            delta = current["stars"] - stars
            windows[str(days)] = {
                "delta": delta,
                "rate": round(100 * delta / stars, 4) if stars else None,
                "baseline": stars,
                "rate_rankable": stars >= MIN_BASE_STARS_FOR_RATE_RANK,
                "from": at.isoformat().replace("+00:00", "Z"),
                "to": latest_date.isoformat().replace("+00:00", "Z"),
            }
        records[catalog_name] = {
            "id": repo_id, "name": current["name"],
            "stars": current["stars"], "as_of": latest_date.isoformat().replace("+00:00", "Z"),
            "windows": windows,
            "history": [[at.date().isoformat(), stars] for at, stars in points],
        }
    return {
        "schema": 1, "as_of": latest_date.isoformat().replace("+00:00", "Z"),
        "snapshot_days": len(snapshots),
        "coverage": {"total": len(catalog), "collected": len(records)},
        "records": records,
    }


def build(root: Path) -> dict:
    catalog = json.loads((root / "data" / "repos.json").read_text(encoding="utf-8"))
    payload = compile_metrics(catalog, read_snapshots(root / "data" / "star-history"))
    path = root / "data" / "star-growth.json"
    content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    path.write_text(content, encoding="utf-8")
    return payload


if __name__ == "__main__":
    project = Path(__file__).resolve().parents[1]
    result = build(project)
    print(f"Growth metrics: {result['snapshot_days']} days, {len(result['records'])} repositories")
