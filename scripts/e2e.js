#!/usr/bin/env node
/**
 * 端到端自测：起一个模拟的 OneBot 服务端，再起机器人，验证「收到消息 -> 模型回复 -> 画图 -> 图片送达」。
 * 完全离线于 QQ，只需要能访问 DeepSeek 接口；出图用 mock 后端，不消耗免费额度。
 *
 *   node scripts/e2e.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-e2e-'));
const configPath = path.join(tmp, 'config.json');
const dataDir = path.join(tmp, 'data');

const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const config = {
  ...example,
  onebot: { wsUrl: 'ws://127.0.0.1:3199', accessToken: '', httpUrl: '' },
  access: { mode: 'whitelist', adminQQ: ['10001'], privateAllow: ['10001'], groupAllow: ['90001'], allowAllWhenEmpty: false },
  image: { ...example.image, provider: 'mock', cooldownMs: 1000 },
  console: { ...example.console, enabled: false },
  log: { level: 'info', file: false },
};
if (!config.llm.apiKey) {
  const real = path.join(ROOT, 'config.json');
  if (fs.existsSync(real)) config.llm.apiKey = JSON.parse(fs.readFileSync(real, 'utf8')).llm?.apiKey ?? '';
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const env = { ...process.env, QQBOT_CONFIG: configPath, QQBOT_DATA: dataDir };
const children = [];
const output = [];

function run(name, args) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true });
  children.push(child);
  child.stdout.on('data', (d) => {
    const text = d.toString();
    output.push(`[${name}] ${text.trimEnd()}`);
    process.stdout.write(`[${name}] ${text}`);
  });
  child.stderr.on('data', (d) => {
    const text = d.toString();
    output.push(`[${name}!] ${text.trimEnd()}`);
    process.stderr.write(`[${name}!] ${text}`);
  });
  return child;
}

function cleanup(code) {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 300);
}

const timeout = setTimeout(() => {
  console.error('\n[失败] 90 秒内没有跑完自测');
  cleanup(1);
}, 90000);

run('mock', ['src/mock-onebot.js', '--port', '3199', '--qq', '10001', '--group', '90001', '--message', '在吗||今天好累啊||给我画一只猫']);
setTimeout(() => {
  run('bot', ['src/index.js']);
}, 800);

// 等到 mock 报出“收到了机器人的图片”就算通过
const timer = setInterval(() => {
  const text = output.join('\n');
  const replies = (text.match(/机器人回复/g) || []).length;
  const images = (text.match(/图片已保存/g) || []).length;
  if (images > 0 && replies >= 4) {
    clearInterval(timer);
    clearTimeout(timeout);
    console.log(`\n[通过] 收到 ${replies} 条回复、${images} 张图片`);
    cleanup(0);
  }
}, 500);
