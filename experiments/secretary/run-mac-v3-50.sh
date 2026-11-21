#!/bin/bash
set -euo pipefail
export WHALE_SUITE_V3_50=1
exec /bin/bash "$(dirname "$0")/run-mac.sh" "$@"
