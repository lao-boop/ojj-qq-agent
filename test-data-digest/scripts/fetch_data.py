#!/usr/bin/env python3
"""Download a pinned dataset described by manifest.json, then verify every file."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath

DEFAULT_BASES = {
    "huggingface": "https://huggingface.co/datasets",
    "modelscope": "https://modelscope.cn/datasets",
}
TOKEN_ENV = {
    "huggingface": "HF_TOKEN",
    "modelscope": "MODELSCOPE_API_TOKEN",
}


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def safe_dest(dest: Path, rel: str) -> Path:
    rel_path = PurePosixPath(rel)
    if rel_path.is_absolute() or ".." in rel_path.parts:
        raise ValueError(f"unsafe manifest path: {rel!r}")
    target = (dest / Path(*rel_path.parts)).resolve()
    root = dest.resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"path escapes destination: {rel!r}")
    return target


def load_manifest(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data.get("files"), list):
        raise SystemExit("manifest.json has no files[]")
    return data


def resolve_source(manifest: dict, name: str, revision_override: str | None = None) -> dict:
    source = (manifest.get("sources") or {}).get(name)
    if not source:
        raise SystemExit(f"manifest does not define sources.{name}")
    repo = str(source.get("repo") or "").strip()
    revision = str(revision_override or source.get("revision") or "").strip()
    if not repo or repo == "TO_FILL":
        raise SystemExit(f"sources.{name}.repo is not set")
    if not revision or revision == "TO_FILL":
        raise SystemExit(
            f"sources.{name}.revision is not pinned. Set it to an immutable commit sha."
        )
    base = str(source.get("base_url") or DEFAULT_BASES[name]).rstrip("/")
    return {
        "name": name,
        "repo": repo,
        "revision": revision,
        "base": base,
        "url": f"{base}/{urllib.parse.quote(repo, safe='/')}/resolve/{urllib.parse.quote(revision, safe='')}",
    }


def check_local(path: Path, entry: dict) -> str:
    """Return ok / missing / bad."""
    if not path.exists():
        return "missing"
    if path.stat().st_size != int(entry["bytes"]):
        return "bad"
    expected = str(entry.get("sha256") or "").lower()
    if len(expected) != 64:
        return "bad"
    return "ok" if sha256_file(path) == expected else "bad"


def download_one(entry: dict, source: dict, dest: Path, token: str | None, timeout: int = 120) -> str:
    rel = str(entry["path"])
    target = safe_dest(dest, rel)
    target.parent.mkdir(parents=True, exist_ok=True)

    state = check_local(target, entry)
    if state == "ok":
        return "skip"
    if state == "bad":
        target.unlink(missing_ok=True)

    part = target.with_name(target.name + ".part")
    url = f"{source['url']}/{urllib.parse.quote(rel, safe='/')}"
    headers = {"User-Agent": "agent-test-data-fetch/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    existing = part.stat().st_size if part.exists() else 0
    if existing:
        headers["Range"] = f"bytes={existing}-"

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            mode = "ab" if existing and getattr(resp, "status", 200) == 206 else "wb"
            if mode == "wb" and existing:
                existing = 0
            with part.open(mode) as f:
                while True:
                    block = resp.read(1024 * 1024)
                    if not block:
                        break
                    f.write(block)
    except urllib.error.HTTPError as e:
        if e.code == 416 and existing:
            part.unlink(missing_ok=True)
        raise RuntimeError(f"{rel}: HTTP {e.code}") from e

    if part.stat().st_size != int(entry["bytes"]):
        part.unlink(missing_ok=True)
        raise RuntimeError(f"{rel}: size mismatch")
    actual = sha256_file(part)
    expected = str(entry["sha256"]).lower()
    if actual != expected:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"{rel}: sha256 mismatch ({actual[:12]} != {expected[:12]})")
    part.replace(target)
    return "download"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", default="manifest.json")
    ap.add_argument("--dest", default="data/raw")
    ap.add_argument("--source", choices=sorted(DEFAULT_BASES), default="huggingface")
    ap.add_argument("--revision", default=None, help="optional explicit revision; default is pinned in manifest")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fail-fast", action="store_true")
    args = ap.parse_args()

    manifest = load_manifest(Path(args.manifest))
    source = resolve_source(manifest, args.source, args.revision)
    dest = Path(args.dest)
    files = manifest["files"]
    token = os.environ.get(TOKEN_ENV[args.source]) or None

    print(f"source : {source['name']} / {source['repo']} @ {source['revision']}")
    print(f"dest   : {dest.resolve()}")
    print(f"files  : {len(files):,} / {sum(int(x['bytes']) for x in files):,} bytes")
    if args.dry_run:
        return 0

    if args.verify_only:
        missing = bad = ok = 0
        for entry in files:
            state = check_local(safe_dest(dest, entry["path"]), entry)
            if state == "ok":
                ok += 1
            elif state == "missing":
                missing += 1
            else:
                bad += 1
                print(f"BAD   {entry['path']}", file=sys.stderr)
        print(f"verified: ok={ok:,} missing={missing:,} bad={bad:,}")
        return 0 if missing == bad == 0 else 1

    counts = {"skip": 0, "download": 0, "error": 0}
    started = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {
            pool.submit(download_one, entry, source, dest, token, args.timeout): entry
            for entry in files
        }
        for done, fut in enumerate(as_completed(futures), 1):
            entry = futures[fut]
            try:
                result = fut.result()
                counts[result] += 1
            except Exception as exc:
                counts["error"] += 1
                print(f"ERROR {entry['path']}: {exc}", file=sys.stderr)
                if args.fail_fast:
                    for f in futures:
                        f.cancel()
                    break
            if done % 100 == 0 or done == len(files):
                elapsed = time.time() - started
                print(f"{done:,}/{len(files):,}  {counts}  {elapsed:.1f}s")

    print(f"done: {counts}")
    return 0 if counts["error"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
