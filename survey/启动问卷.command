#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/opt/node@24/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then echo '请安装 Node.js 24 后重试'; read -r; exit 1; fi
export PORT=3020
export HOST=0.0.0.0
node server.mjs &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for n in {1..40}; do
  kill -0 "$server_pid" 2>/dev/null || { echo '启动失败，请查看上方提示'; read -r; exit 1; }
  if curl -fsS http://127.0.0.1:3020/items.json >/dev/null 2>&1; then
    open http://127.0.0.1:3020
    lan_ip=$(ipconfig getifaddr en0 || ipconfig getifaddr en1)
    if [ -n "$lan_ip" ]; then echo "同一局域网的参与者可打开：http://$lan_ip:3020"; fi
    echo '点击网页的「数据后台」，登录口令如下：'
    cat data/admin-key.txt; echo
    break
  fi
  sleep 0.2
done
wait "$server_pid"
