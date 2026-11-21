import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'wecom-groups.json');

export function loadGroups() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function listGroups() {
  return Object.entries(loadGroups()).map(([name, g]) => ({
    name,
    chatid: g.chatid || '',
    members: Array.isArray(g.members) ? g.members : [],
  }));
}

export function findGroup(name) {
  const q = String(name || '').trim();
  if (!q) return null;
  const groups = loadGroups();
  if (groups[q]) return { name: q, ...groups[q] };
  const lower = q.toLowerCase();
  for (const [key, value] of Object.entries(groups)) {
    if (key.toLowerCase() === lower) return { name: key, ...value };
  }
  for (const [key, value] of Object.entries(groups)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) {
      return { name: key, ...value };
    }
  }
  return null;
}

export function groupFile() {
  return FILE;
}

function saveGroups(map) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function normalizeGroup(name) {
  return String(name || '')
    .replace(/^[\s，,：:、]+/, '')
    .replace(/[的里]$/, '')
    .trim()
    .slice(0, 20);
}

export function addMember(groupName, member) {
  const name = normalizeGroup(groupName);
  const m = String(member || '').trim();
  if (!name || !m) return false;
  const groups = loadGroups();
  const g = groups[name] || { members: [] };
  const members = Array.isArray(g.members) ? g.members : [];
  if (!members.includes(m)) members.push(m);
  groups[name] = { ...g, members };
  saveGroups(groups);
  return true;
}

export function removeMember(groupName, member) {
  const name = normalizeGroup(groupName);
  const m = String(member || '').trim();
  if (!name || !m) return false;
  const groups = loadGroups();
  const g = groups[name];
  if (!g || !Array.isArray(g.members)) return false;
  const before = g.members.length;
  g.members = g.members.filter((x) => x !== m);
  if (g.members.length === before) return false;
  saveGroups(groups);
  return true;
}

/**
 * 解析“我是宣传组的 / 把张三加到宣传组 / 把张三移出宣传组”。
 * 返回 { action, group, names, self } 或 null。
 */
export function parseGroupAssignment(text, { isBoss = false } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const groupRe = '([\\u4e00-\\u9fa5A-Za-z0-9_]{1,20}组)';

  // 员工自报：我是宣传组的 / 我在宣传组 / 我属于宣传组
  const self = new RegExp(`我(?:是|在|属于|归|进|加入)\\s*${groupRe}(?:的|里|成员)?`).exec(raw);
  if (self) return { action: 'add', group: self[1], names: [], self: true };

  if (!isBoss) return null;

  // 移出：把张三从宣传组移出 / 宣传组移除张三
  let m = new RegExp(
    `(?:把|让|将|请)?\\s*([^\\s，,。：:]{1,30}?)\\s*从\\s*${groupRe}\\s*(?:移出|踢出|移除|删掉|去掉)`,
  ).exec(raw);
  if (!m) {
    m = new RegExp(`${groupRe}\\s*(?:移出|踢出|移除|删掉|去掉)\\s*([^\\s，,。：:]{1,30})`).exec(raw);
    if (m) return { action: 'remove', group: m[1], names: splitNames(m[2]), self: false };
  } else {
    return { action: 'remove', group: m[2], names: splitNames(m[1]), self: false };
  }

  // 加入：把张三加到宣传组 / 让张三和李四加入宣传组 / 张三在宣传组
  m = new RegExp(
    `(?:把|让|将|请)?\\s*([^\\s，,。：:]{1,30}?)\\s*(?:加入|加到|加进|放进|放到|归到|归入|安排到|属于|在)\\s*${groupRe}`,
  ).exec(raw);
  if (m) return { action: 'add', group: m[2], names: splitNames(m[1]), self: false };

  return null;
}

function splitNames(input) {
  return String(input || '')
    .split(/[和与及、,，\s]+/)
    .map((s) => s.replace(/^(把|让|将|请)/, '').trim())
    .filter(Boolean)
    .slice(0, 20);
}
