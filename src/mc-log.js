import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'mc-actions.json');
const MAX = 300;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** 记一条 MC 里发生的事（进服、走、挖、说话、聊天）。 */
export function logMc({ kind, detail = '' }) {
  const list = load();
  list.push({ at: Date.now(), kind: String(kind || '').slice(0, 20), detail: String(detail || '').slice(0, 160) });
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list.slice(-MAX), null, 0), 'utf8');
  } catch {
    /* ignore */
  }
}

export function recentMc(limit = 10) {
  return load().slice(-limit);
}

function hhmm(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 注入 QQ 对话用：最近在游戏里干了什么。 */
export function formatMcDigest(limit = 8) {
  const items = recentMc(limit);
  if (!items.length) return '';
  return `【最近在 Minecraft 里】\n${items.map((m) => `- ${hhmm(m.at)} ${m.kind}${m.detail ? `：${m.detail}` : ''}`).join('\n')}`;
}
