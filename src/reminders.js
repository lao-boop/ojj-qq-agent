import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'reminders.json');

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
    fs.writeFileSync(FILE, JSON.stringify(list.slice(-500), null, 2), 'utf8');
  } catch {}
}

export function addReminder({ chatKey, text, dueAt }) {
  const item = {
    id: `rm${Date.now()}${Math.floor(Math.random() * 1000)}`,
    chatKey: String(chatKey || ''),
    text: String(text || '').slice(0, 200),
    dueAt: Number(dueAt) || Date.now(),
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
  };
  const list = load();
  list.push(item);
  save(list);
  return item;
}

export function listReminders(chatKey) {
  return load().filter((r) => r.status === 'pending' && (!chatKey || r.chatKey === chatKey));
}

export function cancelLatest(chatKey, keyword = '') {
  const list = load();
  const kw = String(keyword || '').trim();
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.status !== 'pending') continue;
    if (chatKey && r.chatKey !== chatKey) continue;
    if (kw && !String(r.text || '').includes(kw)) continue;
    r.status = 'cancelled';
    r.finishedAt = Date.now();
    save(list);
    return r;
  }
  return null;
}

export function dueReminders(now = Date.now()) {
  return load().filter((r) => r.status === 'pending' && r.dueAt <= now);
}

export function updateReminder(id, patch) {
  const list = load();
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch);
  save(list);
  return r;
}

export function startReminderQueue({ send, logger, intervalMs = 15000 } = {}) {
  const timer = setInterval(async () => {
    for (const r of dueReminders()) {
      updateReminder(r.id, { status: 'sending', attempts: (r.attempts || 0) + 1 });
      try {
        const result = await send(r);
        if (result?.ok) {
          updateReminder(r.id, { status: 'sent', finishedAt: Date.now() });
          logger?.info?.(`提醒已发送：${r.chatKey} ${r.text.slice(0, 30)}`);
        } else {
          throw new Error(result?.error || '发送失败');
        }
      } catch (err) {
        const attempts = (r.attempts || 0) + 1;
        if (attempts >= 3) {
          updateReminder(r.id, { status: 'failed', finishedAt: Date.now(), error: String(err.message || err) });
          logger?.warn?.(`提醒发送失败（${r.id}）：${err.message}`);
        } else {
          updateReminder(r.id, { status: 'pending', attempts, dueAt: Date.now() + 60000 * attempts });
        }
      }
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export function remindersFile() {
  return FILE;
}
