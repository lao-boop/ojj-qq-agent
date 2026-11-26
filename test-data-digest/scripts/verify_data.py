#!/usr/bin/env python3
"""Verify a local dataset checkout against manifest.json without downloading."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from fetch_data import check_local, load_manifest, safe_dest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", default="manifest.json")
    ap.add_argument("--data", default="data/raw")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    manifest = load_manifest(Path(args.manifest))
    data = Path(args.data)
    ok = missing = bad = 0
    for entry in manifest["files"]:
        state = check_local(safe_dest(data, entry["path"]), entry)
        if state == "ok":
            ok += 1
        elif state == "missing":
            missing += 1
            if not args.quiet:
                print(f"MISSING {entry['path']}", file=sys.stderr)
        else:
            bad += 1
            if not args.quiet:
                print(f"BAD     {entry['path']}", file=sys.stderr)

    print(f"ok={ok:,} missing={missing:,} bad={bad:,} total={len(manifest['files']):,}")
    return 0 if missing == bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
