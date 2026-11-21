import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'wecom-activity.jsonl');
const MAX = 5000;

function startOfDay() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function logActivity({ userid, name = '', chattype = '', chatid = '', text = '', kind = 'chat' }) {
  const uid = String(userid || '').trim();
  if (!uid) return;
  const line = JSON.stringify({
    at: Date.now(),
    userid: uid,
    name: String(name || '').slice(0, 40),
    chattype,
    chatid: String(chatid || '').slice(0, 64),
    kind,
    text: String(text || '').slice(0, 1000),
  });
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, `${line}\n`, 'utf8');
    // 偶尔裁剪，避免无限增长
    if (Math.random() < 0.02) trim();
  } catch {
    /* ignore */
  }
}

function trim() {
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX) {
      fs.writeFileSync(FILE, `${lines.slice(-MAX).join('\n')}\n`, 'utf8');
    }
  } catch {
    /* ignore */
  }
}

export function todayActivities() {
  try {
    const since = startOfDay();
    return fs
      .readFileSync(FILE, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.at >= since);
  } catch {
    return [];
  }
}

/** 按员工分组，返回 [{ userid, name, items: [text] }] */
export function groupToday() {
  const map = new Map();
  for (const a of todayActivities()) {
    if (!a.text) continue;
    const key = a.userid;
    if (!map.has(key)) map.set(key, { userid: key, name: a.name || key, items: [] });
    const g = map.get(key);
    if (a.name) g.name = a.name;
    g.items.push(`[${a.kind === 'relay' ? '传话' : a.chattype === 'group' ? '群' : '私聊'}] ${a.text}`);
  }
  return [...map.values()];
}
