#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$bundle_root/apps/ojj-qq-agent"
node --test --test-concurrency=1 tests/*.test.js
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
