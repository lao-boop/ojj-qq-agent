#!/bin/bash
set -euo pipefail
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  echo '需要在 Mac 上运行。'
  exit 1
fi
pilot_brew=$(command -v brew || true)
if [ -z "$pilot_brew" ]; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then pilot_brew=$candidate; break; fi
  done
fi
if [ -z "$pilot_brew" ]; then echo '未找到 Homebrew，请先安装基础工具。'; exit 1; fi
pilot_python="$("$pilot_brew" --prefix python@3.11)/bin/python3.11"
if [ ! -x "$pilot_python" ]; then echo '请先执行 brew install python@3.11 node@24 cliclick'; exit 1; fi
mkdir -p "$HOME/wechat-assistant"
if [ ! -x "$HOME/wechat-assistant/.venv/bin/python" ]; then
  "$pilot_python" -m venv "$HOME/wechat-assistant/.venv"
fi
"$HOME/wechat-assistant/.venv/bin/python" -m pip install --only-binary=:all: \
  pyobjc-framework-Quartz==12.2.1 pyobjc-framework-Vision==12.2.1 Pillow==12.3.0
echo '试运行依赖安装完成，没有启动微信自动化。'
echo '在仓库目录运行：bash scripts/run-mac-pilot.command "联系人唯一备注"'
