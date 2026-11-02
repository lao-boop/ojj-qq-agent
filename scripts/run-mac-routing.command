#!/bin/bash
set -euo pipefail
if [ "$#" -lt 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  echo '用法：bash scripts/run-mac-routing.command "员工唯一备注" "老板唯一备注" [--check-service|--check-contacts] [--interval 300]'
  exit 1
fi
routing_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
routing_python="$HOME/wechat-assistant/.venv/bin/python"
if [ ! -x "$routing_python" ]; then
  echo '请先运行 bash scripts/setup-mac-pilot.command'
  exit 1
fi
routing_staff=$1
routing_boss=$2
shift 2
exec "$routing_python" "$routing_root/scripts/mac-wechat-routing.py" --staff "$routing_staff" --boss "$routing_boss" "$@"
