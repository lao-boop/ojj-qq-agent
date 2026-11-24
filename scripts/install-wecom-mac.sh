#!/bin/bash
set -euo pipefail
bundle_dir="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="${1:-$HOME/Downloads/ojj-qq-agent-codex-wecom-integration}"
test -f "$runtime_dir/src/wecom-main.js" || { echo '没有找到现有运行目录，请核对路径。'; exit 1; }
case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo '此入口用于 Mac'; exit 1 ;; esac
node_name="node-v24.22.3-darwin-$arch"
cache_root="$HOME/Library/Caches/whale-secretary-experiment"
node_bin="$cache_root/$node_name/bin/node"
if [ ! -x "$node_bin" ]; then
  for candidate in "$HOME"/Downloads/whale-experiment.*/node-runtime/"$node_name"/bin/node; do
    if [ -x "$candidate" ]; then
      mkdir -p "$cache_root"
      cp -R "$(dirname "$(dirname "$candidate")")" "$cache_root/"
      break
    fi
  done
fi
if [ ! -x "$node_bin" ]; then echo '没有找到上次实验使用的官方 Node 24，请保留原实验目录。尚未修改机器人。'; exit 1; fi
"$node_bin" -e 'if(Number(process.versions.node.split(".")[0])<24) throw Error("需要 Node 24+")'
export PATH="$(dirname "$node_bin"):$PATH"
"$node_bin" "$bundle_dir/scripts/install-wecom-local.mjs" "$runtime_dir"
printf '\n需要启动时，在终端执行：\ncd %q && NODE_USE_ENV_PROXY=1 PATH=%q:$PATH npm run start:wecom\n' "$runtime_dir" "$(dirname "$node_bin")"
