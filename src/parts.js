import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const CATALOG = path.join(DATA_DIR, 'knowledge', 'parts_catalog.jsonl');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = fs
      .readFileSync(CATALOG, 'utf8')
      .split(/\r?\n/)
      .filter((s) => s.trim())
      .map((s) => JSON.parse(s));
  } catch {
    cache = [];
  }
  return cache;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s，,。；;、()（）【】\[\]]/g, '');
}

/** 按名称/俗称/外观线索检索配件分类库（本地 24 类）。 */
export function lookupPart(query, { limit = 3 } = {}) {
  const q = norm(query);
  if (!q) return [];
  const rows = load();
  const scored = [];
  for (const r of rows) {
    let score = 0;
    const names = [r.name_zh, r.name_en, ...(r.aliases || [])].map(norm);
    if (names.some((n) => n === q)) score = 100;
    else if (names.some((n) => n.includes(q) || q.includes(n))) score = 80;
    else if (norm(r.visual_cues).includes(q)) score = 50;
    else if (names.some((n) => q.length >= 1 && q.split('').every((ch) => n.includes(ch)))) score = 40;
    if (score > 0) scored.push({ score, row: r });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.row);
}

export function catalogSize() {
  return load().length;
}
