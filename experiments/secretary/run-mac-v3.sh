#!/bin/bash
set -euo pipefail
export WHALE_ITERATION_V3=1
exec /bin/bash "$(dirname "$0")/run-mac.sh" "$@"
