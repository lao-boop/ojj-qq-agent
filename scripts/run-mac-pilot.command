#!/bin/bash
set -euo pipefail
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ -z "$1" ] || { [ "$#" -eq 2 ] && [ "$2" != '--check-service' ]; }; then
  echo '用法：bash scripts/run-mac-pilot.command "联系人唯一备注" [--check-service]'
  exit 1
fi
pilot_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
pilot_python="$HOME/wechat-assistant/.venv/bin/python"
if [ ! -x "$pilot_python" ]; then
  echo '请先运行 bash scripts/setup-mac-pilot.command'
  exit 1
fi
pilot_peer=$1
shift
exec "$pilot_python" "$pilot_root/scripts/mac-wechat-pilot.py" --peer "$pilot_peer" "$@"
