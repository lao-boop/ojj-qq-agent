import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'doc-inbox.json');
const MAX = 400;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list.slice(-MAX), null, 0), 'utf8');
  } catch {
    /* ignore */
  }
}

/** 员工发来的文档进收件箱。同一路径同一人只记一次。 */
export function addDoc({ uin, senderName = '', chatKey = '', name, filePath, text = '', chars = 0, images = 0 }) {
  if (!uin || !name) return false;
  const list = load();
  if (list.some((d) => d.uin === String(uin) && d.path === filePath)) return false;
  list.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    uin: String(uin),
    senderName: String(senderName || '').slice(0, 40),
    chatKey,
    name: String(name).slice(0, 120),
    path: String(filePath || ''),
    chars: Number(chars) || 0,
    images: Number(images) || 0,
    text: String(text || '').slice(0, 6000),
    summarized: false,
  });
  save(list);
  return true;
}

/** 最近 N 小时的文档；默认只要没汇总过的。 */
export function listDocs({ hours = 24, includeSummarized = false } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  return load()
    .filter((d) => d.at >= since && (includeSummarized || !d.summarized))
    .sort((a, b) => a.at - b.at);
}

/** 最近收到的一份文档（可按会话、文件名关键词过滤）。 */
export function latestDoc({ chatKey = '', keyword = '', hours = 168 } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  const kw = String(keyword || '').trim().toLowerCase();
  const list = load()
    .filter((d) => d.at >= since)
    .filter((d) => (chatKey ? d.chatKey === chatKey : true))
    .filter((d) => (kw ? String(d.name || '').toLowerCase().includes(kw) : true))
    .sort((a, b) => b.at - a.at);
  return list[0] || null;
}

export function markSummarized(ids = []) {  if (!ids.length) return;
  const set = new Set(ids);
  const list = load();
  for (const d of list) if (set.has(d.id)) d.summarized = true;
  save(list);
}

export function inboxStats() {
  const list = load();
  return {
    total: list.length,
    pending: list.filter((d) => !d.summarized).length,
    senders: new Set(list.map((d) => d.uin)).size,
  };
}
