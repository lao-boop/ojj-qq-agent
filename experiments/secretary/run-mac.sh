#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "$(uname -s)" != Darwin ]; then echo '本入口用于 Mac；云端请直接运行 experiment-secretary.mjs。'; exit 1; fi
runtime_dir="${1:-$HOME/Downloads/ojj-qq-agent-codex-wecom-integration}"
resume_root="${2:-}"
if [ -n "$resume_root" ] && [ ! -d "$resume_root" ]; then echo '上次结果目录不存在，请核对路径。'; exit 1; fi
if [ ! -f "$runtime_dir/config.json" ] && [ ! -f "$runtime_dir/.env" ]; then
  runtime_dir=$(osascript -e 'POSIX path of (choose folder with prompt "请选择小鲸鱼现有运行目录（含 config.json 或 .env），仅读取模型配置")')
fi
if [ ! -f "$runtime_dir/config.json" ] && [ ! -f "$runtime_dir/.env" ]; then echo '所选目录没有模型配置。'; exit 1; fi

# Use the standalone official runtime; do not repair or replace Homebrew's Node.
arch=$(uname -m)
case "$arch" in arm64) ;; x86_64) arch=x64 ;; *) echo '暂不支持此 Mac 架构'; exit 1 ;; esac
node_name="node-v24.22.3-darwin-$arch"
node_bin="${WHALE_EXPERIMENT_NODE:-}"
if [ -z "$node_bin" ]; then
  for candidate in "$HOME"/Downloads/whale-experiment.*/node-runtime/"$node_name"/bin/node "$HOME/Library/Caches/whale-secretary-experiment/$node_name/bin/node"; do
    if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
  done
fi
if [ -z "$node_bin" ]; then
  cache_dir="$HOME/Library/Caches/whale-secretary-experiment"
  mkdir -p "$cache_dir"
  (
    cd "$cache_dir"
    curl -fL --retry 2 "https://nodejs.org/dist/v24.22.3/$node_name.tar.gz" -o "$node_name.tar.gz"
    curl -fL --retry 2 'https://nodejs.org/dist/v24.22.3/SHASUMS256.txt' -o SHASUMS256.txt
    awk -v file="$node_name.tar.gz" '$2 == file {print}' SHASUMS256.txt > selected.sha256
    test -s selected.sha256
    shasum -a 256 -c selected.sha256
    tar -xzf "$node_name.tar.gz"
  )
  node_bin="$cache_dir/$node_name/bin/node"
fi
"$node_bin" -e 'if(Number(process.versions.node.split(".")[0])<24) throw Error("需要 Node 24+"); console.log(process.version)'
export PATH="$(dirname "$node_bin"):$PATH"
npm ci --no-audit --no-fund
mkdir -p "$PWD/tmp"
if [ "${WHALE_ITERATION_V2:-}" = 1 ] || [ "${WHALE_ITERATION_V3:-}" = 1 ]; then
  iteration_version=v2
  if [ "${WHALE_ITERATION_V3:-}" = 1 ]; then iteration_version=v3; fi
  result_dir=$(mktemp -d "$PWD/tmp/secretary-iteration-$iteration_version.XXXXXX")
  set -- --live --config "$runtime_dir/config.json" --out "$result_dir"
  if [ "$iteration_version" = v3 ]; then set -- "$@" --v3; fi
  if [ -n "$resume_root" ]; then set -- "$@" --resume-from "$resume_root"; fi
  iteration_status=0
  if [ -f "$runtime_dir/.env" ]; then
    NODE_USE_ENV_PROXY=1 "$node_bin" "--env-file=$runtime_dir/.env" scripts/iterate-secretary.mjs "$@" || iteration_status=$?
  else
    NODE_USE_ENV_PROXY=1 "$node_bin" scripts/iterate-secretary.mjs "$@" || iteration_status=$?
  fi
  tar -czf "$result_dir.tar.gz" -C "$result_dir" .
  if [ -f "$result_dir/comparison.html" ]; then open "$result_dir/comparison.html"; fi
  open -R "$result_dir.tar.gz"
  printf '\n已保留全部结果（含失败）。请上传 Finder 选中的文件：\n%s.tar.gz\n' "$result_dir"
  exit "$iteration_status"
fi
result_dir=$(mktemp -d "$PWD/tmp/secretary-compare.XXXXXX")

# Explicit branches are compatible with macOS Bash 3.2 + set -u (no empty array expansion).
run_experiment() {
  if [ -f "$runtime_dir/.env" ]; then
    NODE_USE_ENV_PROXY=1 "$node_bin" "--env-file=$runtime_dir/.env" scripts/experiment-secretary.mjs --live --config "$runtime_dir/config.json" "$@"
  else
    NODE_USE_ENV_PROXY=1 "$node_bin" scripts/experiment-secretary.mjs --live --config "$runtime_dir/config.json" "$@"
  fi
}
run_batch() {
  set -- --algorithm "$algorithm" --split "$split" --out "$result_dir/$algorithm-$split"
  if [ -n "$resume_root" ] && [ -f "$resume_root/$algorithm-$split/manifest.json" ]; then
    set -- "$@" --resume-from "$resume_root/$algorithm-$split"
  fi
  run_experiment "$@"
}
failures=0
for split in dev holdout; do
  for algorithm in baseline upgraded; do
    if run_batch; then
      echo "$algorithm/$split 已完成"
    else
      batch_status=$?
      failures=$((failures+1))
      if [ "$batch_status" -eq 2 ]; then
        echo '模型请求失败，已暂停余下批次；成功结果保留，下次可从此结果目录续跑。'
        break 2
      fi
      echo "$algorithm/$split 有生成或链路检查失败，已记录原因。"
    fi
  done
done
node scripts/compare-secretary.mjs "$result_dir"
printf '\n完成，失败批次：%s。请先查看对照文件：\n%s/comparison.md\n' "$failures" "$result_dir"
tar -czf "$result_dir.tar.gz" -C "$result_dir" .
open -a TextEdit "$result_dir/comparison.md"
open -R "$result_dir.tar.gz"
printf '\n请上传 Finder 选中的结果包：\n%s.tar.gz\n' "$result_dir"
test "$failures" -eq 0
