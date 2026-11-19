#!/bin/bash
# macOS comes with ssh, curl, caffeinate and pbcopy. Only the survey port is shared.
set -u
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
umask 077
fail() { echo; echo "$1"; echo '按回车关闭。'; read -r _; exit 1; }
command -v node >/dev/null || fail '需要 Node.js 24。请先安装，然后重新打开。'
node -e "require('node:sqlite')" >/dev/null 2>&1 || fail '当前 Node 不支持 SQLite，请使用 Node.js 24。'
state=$(mktemp -d) || exit 1
server_pid=''
relay_pid=''
awake_pid=''
cleanup() {
  for pid in "$relay_pid" "$awake_pid" "$server_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  rm -f "$state/server" "$state/relay" "$state/items"
  rmdir "$state" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
export HOST=127.0.0.1 PORT=0
export SURVEY_DATA="${SURVEY_DATA:-$PWD/data}"
node server.mjs >"$state/server" 2>&1 &
server_pid=$!
local_url=''
for n in {1..50}; do
  kill -0 "$server_pid" 2>/dev/null || fail '问卷服务启动失败，请检查 Node 版本和文件夹写入权限。'
  local_url=$(sed -nE 's/^问卷 (http:\/\/127\.0\.0\.1:[0-9]+) .*/\1/p' "$state/server")
  [ -n "$local_url" ] && break
  sleep 0.1
done
[ -n "$local_url" ] || fail '未取得本机问卷地址。'
port=${local_url##*:}
echo '正在为这台 Mac 上的问卷申请临时公网链接…'
# Anonymous tunnel: do not offer any personal SSH keys or forward an agent.
ssh -F /dev/null -nT -o BatchMode=yes -o PubkeyAuthentication=no \
  -o ForwardAgent=no -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=12 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
  -R "80:127.0.0.1:$port" nokey@localhost.run >"$state/relay" 2>&1 &
relay_pid=$!
public_url=''
for n in {1..40}; do
  kill -0 "$relay_pid" 2>/dev/null || break
  public_url=$(LC_ALL=C grep -Eo 'https://[a-zA-Z0-9-]+\.(lhr\.life|localhost\.run)' "$state/relay" | tail -1)
  [ -n "$public_url" ] && break
  sleep 1
done
[ -n "$public_url" ] || fail '未取得公网链接。这条网络可能无法连接 localhost.run 的 SSH 服务。可以换手机热点后重试。'
echo '正在检查公网链接能否读到这份问卷…'
verified=false
for n in {1..3}; do
  if curl -fsS --max-time 8 "$public_url/items.json" -o "$state/items" && cmp -s public/items.json "$state/items"; then
    verified=true
    break
  fi
  sleep 1
done
[ "$verified" = true ] || fail '入口已分配，但本机通过公网未能读回问卷，暂不发群。可以换网络后重试。'
if command -v caffeinate >/dev/null; then caffeinate -i -w "$server_pid" & awake_pid=$!; fi
echo
echo "发到 QQ 群的问卷网址：$public_url/"
if printf '%s/' "$public_url" | pbcopy; then echo '链接已复制，现在可以去 QQ 群粘贴。'; fi
echo
echo "你自己的数据后台：$local_url/admin"
echo '管理口令（请勿发群）：'
cat "$SURVEY_DATA/admin-key.txt"
echo; echo
echo '收集期间保持窗口打开、Mac 联网并保持机盖打开。临时链接重启后可能变化，答卷仍保存在 data 文件夹。'
wait "$relay_pid"
fail '公网连接已结束。重新双击「公网问卷.command」，把重新验证过的链接发给参与者。'
