#!/bin/bash
set -euo pipefail
export WHALE_BUSINESS_V4=1
exec /bin/bash "$(dirname "$0")/run-mac.sh" "$@"
