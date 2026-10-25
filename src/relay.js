import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'relay.json');
const CONTACTS = path.join(DATA_DIR, 'contacts.json');

function loadContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS, 'utf8'));
  } catch {
    return {};
  }
}

/** 记下聊过天的人（uin → 昵称/群名片），方便主人按名字找人。 */
export function upsertContact(uin, name) {
  const id = String(uin || '').trim();
  if (!/^\d{5,12}$/.test(id)) return;
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return;
  const data = loadContacts();
  if (data[id] === clean) return;
  data[id] = clean;
  try {
    fs.mkdirSync(path.dirname(CONTACTS), { recursive: true });
    fs.writeFileSync(CONTACTS, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

/** 按 QQ 号或昵称找联系人。 */
export function findContact(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (/^\d{5,12}$/.test(q)) return { uin: q, name: loadContacts()[q] || q };
  const data = loadContacts();
  const lower = q.toLowerCase();
  for (const [uin, name] of Object.entries(data)) {
    if (String(name).toLowerCase().includes(lower) || lower.includes(String(name).toLowerCase())) {
      return { uin, name };
    }
  }
  return null;
}

export function listContacts() {
  return Object.entries(loadContacts()).map(([uin, name]) => ({ uin, name }));
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { pending: [], delivered: [] };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** 白名单里的人（外加主人自己）才能传话。 */
export function canRelay(uin, cfg) {
  const id = String(uin || '');
  if (!id) return false;
  if (cfg?.relay?.enabled === false) return false;
  const allow = (cfg?.relay?.allow || []).map(String);
  const owner = String(cfg?.access?.ownerQQ || '');
  const admins = (cfg?.access?.adminQQ || []).map(String);
  return allow.includes(id) || id === owner || admins.includes(id);
}

/** 存一条待传话。 */
export function addRelay({ uin, name, text }, cfg) {
  const clean = String(text || '').trim().slice(0, cfg?.relay?.maxLen ?? 200);
  if (!clean) throw new Error('内容为空');
  if (!canRelay(uin, cfg)) throw new Error('不在传话白名单里');

  const data = load();
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = (data.pending || []).filter(
    (m) => String(m.from) === String(uin) && String(m.at || '').slice(0, 10) === today,
  ).length;
  const limit = cfg?.relay?.dailyLimit ?? 5;
  if (limit > 0 && sentToday >= limit) throw new Error('今天传话次数用完了');

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    from: String(uin),
    name: String(name || '').slice(0, 40),
    text: clean,
    at: new Date().toISOString(),
    delivered: false,
  };
  data.pending = [...(data.pending || []), item].slice(-100);
  save(data);
  return item;
}

/** 只读：未送达的传话（不改变状态）。 */
export function peekPending() {
  const data = load();
  return (data.pending || []).filter((m) => !m.delivered);
}

/** 标记这些 id 已送达。 */
export function markDelivered(ids) {
  const set = new Set(ids || []);
  if (!set.size) return;
  const data = load();
  for (const m of data.pending || []) {
    if (set.has(m.id)) {
      m.delivered = true;
      m.deliveredAt = new Date().toISOString();
    }
  }
  save(data);
}

/** 取出所有未送达的传话，并标记为已送达。 */
export function takePending() {
  const data = load();
  const items = (data.pending || []).filter((m) => !m.delivered);
  if (!items.length) return [];
  for (const m of data.pending) m.delivered = true;
  data.delivered = [...(data.delivered || []), ...items.map((m) => ({ ...m, deliveredAt: new Date().toISOString() }))].slice(-200);
  save(data);
  return items;
}

/** 看一眼还有多少条没送。 */
export function pendingCount() {
  const data = load();
  return (data.pending || []).filter((m) => !m.delivered).length;
}
