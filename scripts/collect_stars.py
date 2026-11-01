#!/usr/bin/env python3
"""Collect authentic UTC daily Star snapshots with batched GitHub GraphQL."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib import error, request

ROOT = Path(__file__).resolve().parents[1]
NAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}\Z")
CHUNK_SIZE = 30
MAX_RETRIES = 4
GRAPHQL_URL = "https://api.github.com/graphql"


class CollectionError(RuntimeError):
    pass


def chunks(names, size=CHUNK_SIZE):
    for start in range(0, len(names), size):
        yield names[start:start + size]


def graphql_query(names):
    """Use JSON quoting to safely interpolate repository components."""
    fields = []
    for index, fullname in enumerate(names):
        owner, repo = fullname.split("/", 1)
        fields.append(
            f'r{index}: repository(owner:{json.dumps(owner)},name:{json.dumps(repo)}) '
            '{databaseId nameWithOwner stargazerCount isArchived}'
        )
    return "query StarSnapshot { " + " ".join(fields) + " }"


def fetch_batch(names, token, opener=request.urlopen, sleep=time.sleep):
    query = graphql_query(names)
    body = json.dumps({"query": query}).encode("utf-8")
    request_obj = request.Request(GRAPHQL_URL, data=body, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "trending-agent-skills-star-collector",
    }, method="POST")
    for attempt in range(MAX_RETRIES):
        try:
            with opener(request_obj, timeout=40) as response:
                response_data = json.loads(response.read().decode("utf-8"))
            if not isinstance(response_data, dict) or not isinstance(response_data.get("data"), dict):
                raise CollectionError("GraphQL did not return a data object")
            # Partial GitHub GraphQL errors are normal for deleted/private repos.
            # These are skipped explicitly rather than treated as zero stars.
            if any("rate limit" in str(e.get("message", "")).lower()
                   for e in response_data.get("errors", [])):
                raise CollectionError("GraphQL rate limit response")
            return response_data
        except (error.URLError, TimeoutError, ValueError, CollectionError) as exc:
            if attempt == MAX_RETRIES - 1:
                raise CollectionError(f"GitHub GraphQL request failed: {exc}") from exc
            sleep(min(2 ** attempt, 8))
    raise CollectionError("unreachable retry exhaustion")


def collect(catalog: dict, token: str, fetch=fetch_batch, now=None):
    if not token:
        raise CollectionError("GITHUB_TOKEN is required")
    at = now or datetime.now(timezone.utc)
    if not isinstance(catalog, dict) or not catalog:
        raise CollectionError("catalog is empty or invalid")
    names = sorted(catalog)
    for name in names:
        if not NAME_RE.fullmatch(name) or name.split("/")[1] in (".", ".."):
            raise CollectionError(f"invalid repository name {name}")
    repositories = {}
    aliases = {}
    missing = []
    for batch in chunks(names):
        response = fetch(batch, token)
        data = response["data"]
        for index, requested in enumerate(batch):
            item = data.get(f"r{index}")
            if not item:
                missing.append(requested)
                continue
            repo_id = item.get("databaseId")
            canonical = item.get("nameWithOwner")
            stars = item.get("stargazerCount")
            if (type(repo_id) is not int or repo_id <= 0
                or type(stars) is not int or stars < 0
                or not isinstance(canonical, str) or not NAME_RE.fullmatch(canonical)):
                missing.append(requested)
                continue
            key = str(repo_id)
            old = repositories.get(key)
            if old and (old["stars"] != stars or old["name"] != canonical):
                raise CollectionError(f"inconsistent duplicate ID {key}")
            repositories[key] = {"name": canonical, "stars": stars}
            aliases[requested] = key
    if not repositories:
        raise CollectionError("no repositories could be fetched; refusing empty snapshot")
    return {
        "schema": 1,
        "collected_at": at.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "repositories": repositories, "aliases": aliases,
        "missing": missing,
    }


def main():
    token = os.environ.get("GITHUB_TOKEN", "")
    catalog = json.loads((ROOT / "data" / "repos.json").read_text(encoding="utf-8"))
    snapshot = collect(catalog, token)
    day = snapshot["collected_at"][:10]
    directory = ROOT / "data" / "star-history"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (day + ".json")
    # One UTC snapshot per day; reruns replace the same day atomically.
    temp = target.with_suffix(".json.tmp")
    temp.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(target)
    print(f"Snapshot {day}: {len(snapshot['repositories'])} successful, {len(snapshot['missing'])} missing")
    if snapshot["missing"]:
        print("Unavailable repositories (no fabricated zero counts):", file=sys.stderr)
        for name in snapshot["missing"][:25]:
            print("  " + name, file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except (CollectionError, OSError, ValueError) as exc:
        raise SystemExit(f"Star collection failed: {exc}")
