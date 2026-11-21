#!/bin/bash
set -euo pipefail
export WHALE_ITERATION_V2=1
exec /bin/bash "$(dirname "$0")/run-mac.sh" "$@"
