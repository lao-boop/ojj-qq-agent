#!/usr/bin/env python3
"""Build manifest.json (path, size, sha256) for a local test-data directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, help="local directory containing the raw dataset")
    ap.add_argument("--out", default="manifest.json")
    ap.add_argument("--repo", default="lao-boop/agent-test-data")
    ap.add_argument("--revision", default="TO_FILL", help="immutable HF commit sha/tag")
    ap.add_argument("--modelscope-repo", default="")
    ap.add_argument("--modelscope-revision", default="")
    ap.add_argument("--skip-hidden", action="store_true")
    args = ap.parse_args()

    root = Path(args.source).resolve()
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        if args.skip_hidden:
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if args.skip_hidden and name.startswith("."):
                continue
            p = Path(dirpath) / name
            rel = p.relative_to(root).as_posix()
            st = p.stat()
            files.append((rel, st.st_size))
    files.sort(key=lambda x: x[0])

    entries = []
    total = 0
    for i, (rel, size) in enumerate(files, 1):
        digest = sha256_file(root / rel)
        top = rel.split("/", 1)[0] if "/" in rel else "(root)"
        entries.append({"path": rel, "bytes": size, "sha256": digest, "category": top})
        total += size
        if i % 500 == 0 or i == len(files):
            print(f"hashed {i:,}/{len(files):,}", flush=True)

    sources = {
        "huggingface": {
            "repo": args.repo,
            "repo_type": "dataset",
            "revision": args.revision,
            "url": f"https://huggingface.co/datasets/{args.repo}",
        }
    }
    if args.modelscope_repo:
        sources["modelscope"] = {
            "repo": args.modelscope_repo,
            "repo_type": "dataset",
            "revision": args.modelscope_revision or args.revision,
            "url": f"https://modelscope.cn/datasets/{args.modelscope_repo}",
        }

    manifest = {
        "schema_version": 1,
        "dataset": args.repo.split("/")[-1],
        "version": datetime.now(timezone.utc).strftime("%Y.%m.%d"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sources": sources,
        "stats": {"files": len(entries), "bytes": total},
        "files": entries,
    }
    out = Path(args.out)
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"saved {out}  files={len(entries):,}  bytes={total:,}")


if __name__ == "__main__":
    main()
