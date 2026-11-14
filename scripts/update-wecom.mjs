import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const digest = value => createHash('sha256').update(value).digest('hex');
const ALLOWED = /^(src\/[a-z0-9-]+\.js|scripts\/build_office\.py|public\/index\.html|docs\/WECOM\.md)$/;

export async function installUpdate({ root, manifest, fetchFile, ownerUserId }) {
  if (!ownerUserId || /[\s\x00-\x1f]/.test(ownerUserId)) throw new Error('请填写有效的汇报接收人 UserID');
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error('请先进入小鲸鱼项目目录');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 50) throw new Error('更新清单无效');
  const unique = new Set();
  for (const item of manifest.files) {
    if (!ALLOWED.test(item.path) || unique.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('更新清单包含无效路径或摘要');
    unique.add(item.path);
  }
  const configPath = path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const work = path.join(root, 'work', 'upgrade-' + randomUUID());
  const backup = path.join(work, 'backup');
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const staged = [];
  for (const item of manifest.files) {
    const bytes = Buffer.from(await fetchFile(item.path));
    if (digest(bytes) !== item.sha256) throw new Error(`文件校验失败：${item.path}，尚未修改运行文件`);
    const temp = path.join(work, 'stage', item.path);
    fs.mkdirSync(path.dirname(temp), { recursive: true });
    fs.writeFileSync(temp, bytes);
    if (item.path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', temp], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`代码语法检查失败：${item.path}`);
    }
    staged.push({ ...item, temp });
  }
  // Keep credentials, Python environment paths, conversation data and all other settings.
  config.wecom ??= {};
  config.wecom.secretary = { ...config.wecom.secretary, enabled: true, ownerUserId, intervalMinutes: 60 };
  config.image ??= {};
  config.image.cooldownMs = 0;
  const nextConfig = path.join(work, 'config.json');
  fs.writeFileSync(nextConfig, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  staged.push({ path: 'config.json', temp: nextConfig });
  const applied = [];
  try {
    for (const item of staged) {
      const target = path.join(root, item.path), saved = path.join(backup, item.path);
      const existed = fs.existsSync(target);
      fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
      if (existed) { fs.copyFileSync(target, saved); fs.chmodSync(saved, 0o600); }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(item.temp, target + '.upgrade');
      fs.renameSync(target + '.upgrade', target);
      applied.push({ target, saved, existed });
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.existed) fs.copyFileSync(item.saved, item.target);
      else fs.rmSync(item.target);
    }
    throw error;
  }
  return { backup, updated: manifest.files.length };
}

async function main() {
  const [revision, ownerUserId] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('需要指定更新版本的完整提交编号');
  const root = process.cwd();
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  let running = false;
  try {
    const response = await fetch(`http://127.0.0.1:${config.console?.port || 3010}/api/status`, { signal: AbortSignal.timeout(1000) });
    running = response.ok || response.status === 401;
  } catch { /* No local console is running. */ }
  if (running) throw new Error('请先在运行机器人的终端按 Control+C 停止程序，再执行更新');
  const base = `https://raw.githubusercontent.com/lao-boop/ojj-qq-agent/${revision}/`;
  const fetchFile = async name => {
    const response = await fetch(base + name, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`下载 ${name} 失败：HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const manifest = JSON.parse((await fetchFile('scripts/wecom-update-manifest.json')).toString());
  const result = await installUpdate({ root, manifest, fetchFile, ownerUserId });
  console.log(`更新完成：${result.updated} 个文件。\n秘书将每小时向 ${ownerUserId} 私聊汇报新增消息。\n备份位置：${result.backup}\n请运行 npm run start:wecom 启动。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('更新失败：' + error.message); process.exitCode = 1; });
}
