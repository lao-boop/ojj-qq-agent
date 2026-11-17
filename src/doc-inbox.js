import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';

const MAX = 400;
/** A separate file per channel/bot; old unscoped records remain QQ-only. */
export class DocumentInbox {
  constructor(file = path.join(DATA_DIR, 'doc-inbox.json')) { this.file = file; }
  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('文档收件箱格式无效');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  save(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(list), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  add({ uin, senderName = '', chatKey = '', name, filePath, text = '', chars = 0, images = 0, direction = 'in', messageId = '' }) {
    if (!uin || !name || !filePath) return false;
    const list = this.load();
    if (list.some(d => d.uin === String(uin) && (d.path === filePath || (messageId && d.messageId === messageId && d.name === name)))) return false;
    // Never silently evict unprocessed documents. Reclaim delivered history first.
    if (list.length >= MAX) {
      const index = list.findIndex(d => d.summarized);
      if (index < 0) throw new Error('待汇总文档已满，请先处理收件箱');
      list.splice(index, 1);
    }
    list.push({ id: randomUUID(), at: Date.now(), uin: String(uin), senderName: String(senderName).slice(0, 80),
      chatKey, name: String(name).slice(0, 160), path: String(filePath), chars: Number(chars) || String(text).length,
      images: Number(images) || 0, text: String(text).slice(0, 6000), truncated: String(text).length > 6000 || Number(chars) > String(text).length,
      direction, messageId, summarized: direction === 'out' });
    this.save(list); return true;
  }
  list({ hours = 24, includeSummarized = false } = {}) {
    const since = Date.now() - Math.max(1 / 60, Math.min(720, Number(hours) || 24)) * 3600000;
    return this.load().filter(d => d.at >= since && (includeSummarized || !d.summarized)).sort((a,b) => a.at - b.at);
  }
  latest({ chatKey = '', keyword = '', hours = 168 } = {}) {
    return this.list({hours,includeSummarized:true}).filter(d => (!chatKey || d.chatKey === chatKey)
      && (!keyword || d.name.toLowerCase().includes(String(keyword).toLowerCase()))).at(-1) || null;
  }
  mark(ids) {
    const set = new Set(ids); if (!set.size) return;
    const list = this.load(); for (const doc of list) if (set.has(doc.id)) doc.summarized = true;
    this.save(list);
  }
  stats() { const list = this.load(); return {total:list.length,pending:list.filter(d=>!d.summarized).length,senders:new Set(list.map(d=>d.uin)).size}; }
}
const qqInbox = new DocumentInbox();
export const addDoc = args => qqInbox.add(args);
export const listDocs = args => qqInbox.list(args);
export const latestDoc = args => qqInbox.latest(args);
export const markSummarized = ids => qqInbox.mark(ids);
export const inboxStats = () => qqInbox.stats();
