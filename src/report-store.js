import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Original reports and notification receipts. A failed write never replaces in-memory state. */
export class ReportStore {
  constructor(file) {
    this.file = file;
    try {
      this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (this.state.version !== 1 || !Array.isArray(this.state.records) || !Array.isArray(this.state.deliveries)) {
        throw new Error('Unsupported report store');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`汇报存储无法读取，未覆盖原文件：${err.message}`);
      this.state = { version: 1, records: [], deliveries: [], context: null };
    }
    // A crash after sending is ambiguous. Do not automatically send the same digest again.
    if (this.state.deliveries.some(d => d.status === 'sending')) {
      this.#change(next => {
        for (const d of next.deliveries) if (d.status === 'sending') {
          d.status = 'unknown';
          d.reason = '进程中断，送达结果未确认';
        }
      });
    }
  }

  #change(edit) {
    const next = structuredClone(this.state);
    const result = edit(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.file);
    } catch (err) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch { /* No partial file was created. */ }
      throw err;
    }
    this.state = next;
    return structuredClone(result);
  }

  append(event, platform, now = Date.now()) {
    const sourceMessageId = String(event.message_id ?? '');
    const sourceKey = sourceMessageId ? createHash('sha256').update(JSON.stringify([
      platform, event.self_id, event.message_type, event.user_id, sourceMessageId,
    ])).digest('hex') : '';
    const existing = sourceKey && this.state.records.find(r => r.sourceKey === sourceKey);
    if (existing) return { record: structuredClone(existing), duplicate: true };
    const segments = Array.isArray(event.message) ? event.message : [{ type: 'text', data: { text: String(event.message || '') } }];
    const text = segments.filter(s => s.type === 'text').map(s => String(s.data?.text ?? '')).join('\n');
    const attachments = segments.filter(s => !['text', 'at', 'reply'].includes(s.type)).map(s => ({
      type: String(s.type), name: String(s.data?.name || s.data?.summary || '未命名附件'),
      fileId: String(s.data?.file_id || ''), parsed: false,
    }));
    const timestamp = Number(event.time);
    const record = {
      id: `R${String(this.state.records.length + 1).padStart(6, '0')}`,
      sourceKey, sourceMessageId, platform, accountId: String(event.self_id ?? ''),
      senderId: String(event.user_id), senderName: String(event.sender?.card || event.sender?.nickname || event.user_id),
      receivedAt: new Date(now).toISOString(),
      sentAt: Number.isFinite(timestamp) && timestamp > 0 && timestamp < 1e12 ? new Date(timestamp * 1000).toISOString() : null,
      text, attachments,
      ...(event.source?.kind === 'screen-ocr' ? { source: {
        kind: 'screen-ocr', verified: event.source.verified === true,
        observationId: String(event.source.observationId || ''),
      } } : {}),
      references: segments.filter(s => s.type === 'reply').map(s => String(s.data?.id ?? '')),
    };
    this.#change(next => { next.records.push(record); });
    return { record, duplicate: false };
  }

  records() { return structuredClone(this.state.records); }
  get(id) { return structuredClone(this.state.records.find(r => r.id === id)); }
  deliveries() { return structuredClone(this.state.deliveries); }
  delivery(id) { return structuredClone(this.state.deliveries.find(d => d.id === id)); }
  pending() {
    const reserved = new Set(this.state.deliveries.flatMap(d => d.recordIds));
    return this.records().filter(r => !reserved.has(r.id));
  }
  prepareDelivery(recordIds, targetId, text, now = Date.now()) {
    const entry = { id: `D${String(this.state.deliveries.length + 1).padStart(6, '0')}`, recordIds,
      targetId, text, status: 'sending', attempts: 1, createdAt: new Date(now).toISOString() };
    return this.#change(next => { next.deliveries.push(entry); return entry; });
  }
  updateDelivery(id, patch) {
    return this.#change(next => {
      const entry = next.deliveries.find(d => d.id === id);
      if (!entry) throw new Error('汇总通知不存在');
      Object.assign(entry, patch);
      return entry;
    });
  }
  rememberQuery(bossId, recordIds, query) {
    this.#change(next => { next.context = { bossId, recordIds, query }; });
  }
  context(bossId) { return this.state.context?.bossId === bossId ? structuredClone(this.state.context) : null; }
}
