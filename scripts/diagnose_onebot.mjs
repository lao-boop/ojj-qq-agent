import fs from 'node:fs';
import { CONFIG_PATH, DEFAULTS, deepMerge } from '../src/config.js';
import { OneBot } from '../src/onebot.js';
import { allowedPrivate, allowedGroup } from '../src/access.js';

// Read config without creating directories, rewriting config or loading model clients.
let cfg;
try { cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
catch { console.error('无法读取 config.json，请在项目目录检查配置文件及 JSON 格式。'); process.exit(1); }
const requested = Number(process.argv.find(a => a.startsWith('--seconds='))?.split('=')[1] || 30);
const seconds = Number.isFinite(requested) ? Math.max(1, Math.min(120, requested)) : 30;
const out = message => console.log(`[诊断] ${message}`);
try {
  const url = new URL(cfg.onebot.wsUrl);
  out(`目标 ${url.protocol}//${url.hostname}:${url.port || '(默认端口)'}`);
} catch { out('WebSocket 地址格式错误'); process.exit(1); }
out(`主人QQ=${cfg.access.ownerQQ || '未配置'}，访问模式=${cfg.access.mode}；密钥不输出。`);
out(`接下来 ${seconds} 秒内，请用自己的 QQ 私聊机器人发“测试”。本程序只检查连接和事件，不回复、不调用模型。`);
let ready = false, messages = 0, allowed = 0;
const client = new OneBot({ wsUrl: cfg.onebot.wsUrl, accessToken: cfg.onebot.accessToken, logger: {
  info: () => {}, debug: () => {},
  warn: () => { if (!client.stopped) out('连接或握手异常：检查 NapCat 容器、WebSocket Server 的启用/端口/Token。'); },
  error: () => out('无法建立连接，请核对 WebSocket 地址。'),
} });
client.on('ready', ({ selfId }) => {
  ready = true; out(`登录接口成功，机器人QQ=${selfId}`);
  if (String(selfId) === String(cfg.access.ownerQQ)) out('主人QQ与机器人QQ相同：请把 ownerQQ 改成你用于发消息的个人 QQ。');
});
client.on('message', event => {
  messages++;
  const self = String(event.user_id) === String(client.selfId);
  const permitted = !self && (event.message_type === 'private' ? allowedPrivate(event.user_id, cfg) : allowedGroup(event.group_id, cfg));
  if (permitted) allowed++;
  out(`收到事件：${event.message_type}，发信QQ=${event.user_id}，${self ? '机器人自身消息，忽略' : permitted ? '访问检查通过' : '被访问名单拦截'}`);
});
client.start();
const timer = setTimeout(() => {
  if (!ready) out('未取得登录信息：先修复 NapCat 连接或登录。');
  else if (!messages) out('登录接口正常，但没有消息事件。若刚刚已发消息，请检查发给的QQ、NapCat网络配置中的事件推送，并查看猫猫日志。');
  else if (!allowed) out('收到事件但没有可处理消息：检查发信账号及 access.ownerQQ/privateAllow；群聊另需 groupAllow。');
  else out('消息推送和访问检查通过。若机器人仍不回复，请查看 bot.log 中“消息事件”之后的报错。');
  process.exitCode = !ready ? 2 : allowed ? 0 : 3;
  client.stop(); client.ws?.terminate();
}, seconds * 1000);
process.once('SIGINT', () => { clearTimeout(timer); client.stop(); client.ws?.terminate(); });
