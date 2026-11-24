import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'wecom-users.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function save(map) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function clean(name) {
  return String(name || '')
    .replace(/[，。,.!?！？、\s]/g, '')
    .replace(/^(叫|是)/, '')
    .slice(0, 12);
}

export function rememberName(userid, name) {
  const id = String(userid || '').trim();
  const n = clean(name);
  if (!id || n.length < 1) return false;
  if (['你', '我', '他', '她', '它'].includes(n)) return false;
  if (['老板', '主人', '同事', '客服', '机器人', '小安', '测试'].includes(n)) return false;
  const map = load();
  if (map[id]?.name === n) return false;
  map[id] = { name: n, at: Date.now() };
  save(map);
  return true;
}

/** 从一句话里学习“我叫X / 我的名字是X / 叫我X”。 */
export function learnNameFromText(userid, text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return '';
  const m =
    /(?:我叫|我的名字叫|我的名字是|名字叫|称呼我|叫我)\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})/.exec(t) ||
    /^(?:我是)\s*([\u4e00-\u9fa5]{1,4})$/.exec(t);
  if (!m) return '';
  const name = clean(m[1]);
  if (!name || name.length < 1) return '';
  return rememberName(userid, name) ? name : '';
}

export function findUser(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const map = load();
  if (map[q]) return { userid: q, name: map[q].name };
  const lower = q.toLowerCase();
  for (const [userid, info] of Object.entries(map)) {
    if (String(info.name).toLowerCase() === lower) return { userid, name: info.name };
  }
  for (const [userid, info] of Object.entries(map)) {
    if (String(info.name).toLowerCase().includes(lower) || lower.includes(String(info.name).toLowerCase())) {
      return { userid, name: info.name };
    }
  }
  return null;
}

export function listUsers() {
  return Object.entries(load()).map(([userid, info]) => ({ userid, name: info.name }));
}
