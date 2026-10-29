import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'media-log.json');
const MAX = 5000;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(data)) return [];
    // 按时间排序，保证“最近”拿到的真的是最近的
    return data.sort((a, b) => (a.at || 0) - (b.at || 0));
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list.slice(-MAX), null, 0), 'utf8');
}

/** 记一条收发记录：direction = in / out，kind = audio/doc/image。 */
export function logMedia({ chatKey, actorId = '', direction, kind, name, title = '', path: filePath = '', detail = '', snippet = '', at = 0 }) {
  if (!chatKey) return;
  const list = load();
  list.push({
    at: at || Date.now(),
    chatKey,
    actorId: String(actorId),
    direction,
    kind,
    name: String(name || '').slice(0, 120),
    title: String(title || '').slice(0, 80),
    path: String(filePath || ''),
    detail: String(detail || '').slice(0, 80),
    snippet: String(snippet || '').slice(0, 300),
  });
  save(list);
}

/** 某个会话最近的文件往来。 */
export function recentMedia(chatKey, limit = 8, actorId) {
  return load()
    .filter((m) => m.chatKey === chatKey && (actorId === undefined || !String(chatKey).startsWith('group:') || m.actorId===String(actorId)))
    .slice(-limit);
}

/** 按关键词找（给工具用）。 */
export function searchMedia(keyword, chatKey, limit = 10, actorId) {
  const q = String(keyword || '').toLowerCase();
  return load()
    .filter(
      (m) =>
        (!chatKey || m.chatKey === chatKey) &&
        (actorId === undefined || !String(chatKey).startsWith('group:') || m.actorId===String(actorId)) &&
        (!q || `${m.name} ${m.title} ${m.detail} ${m.snippet || ''}`.toLowerCase().includes(q)),
    )
    .slice(-limit);
}

function hhmm(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 注入提示词用的一段摘要。 */
export function formatMediaDigest(chatKey, limit = 10, actorId) {
  const items = recentMedia(chatKey, limit, actorId);
  if (!items.length) return '';
  const lines = items.map((m) => {
    const who = m.direction === 'in' ? '对方发来' : '我发出去';
    const what = m.kind === 'audio' ? `音频${m.title ? `《${m.title}》` : ''}` : m.kind === 'image' ? '图片' : `文件 ${m.name}`;
    return `- ${hhmm(m.at)} ${who} ${what}${m.detail ? `（${m.detail}）` : ''}`;
  });
  return `【最近的文件往来】\n${lines.join('\n')}`;
}

/** 给工具用的简短清单。 */
export function formatMediaList(items) {
  return items
    .map((m) => {
      const who = m.direction === 'in' ? '对方发来' : '我发出';
      const what = m.kind === 'audio' ? `音频${m.title ? `《${m.title}》` : ''}` : m.kind === 'image' ? '图片' : `文件 ${m.name}`;
      const snip = m.snippet ? `｜${m.snippet.slice(0, 60)}` : '';
      return `- ${hhmm(m.at)} ${who} ${what}${m.detail ? `（${m.detail}）` : ''}${snip}`;
    })
    .join('\n');
}
