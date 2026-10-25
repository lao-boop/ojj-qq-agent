import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { logMedia, recentMedia } from '../src/media-log.js';

const OWNER_CHAT = 'private:123456789';
const FILES_DIR = path.join(DATA_DIR, 'files');

function classify(name, ext) {
  const lower = name.toLowerCase();
  if (ext === '.silk') return { kind: 'audio', direction: 'in', detail: '语音' };
  if (ext === '.mp4' || ext === '.mov') return { kind: 'video', direction: 'in', detail: '' };
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') return { kind: 'image', direction: 'in', detail: '' };
  if (ext === '.docx' || ext === '.pptx' || ext === '.xlsx' || ext === '.pdf') return { kind: 'doc', direction: 'in', detail: ext.slice(1).toUpperCase() };
  if (ext === '.mp3' || ext === '.m4a' || ext === '.wav' || ext === '.flac') {
    if (lower.includes('cover-')) return { kind: 'audio', direction: 'out', detail: '翻唱' };
    return { kind: 'audio', direction: 'in', detail: '' };
  }
  return null;
}

const known = new Set(recentMedia(OWNER_CHAT, 5000).map((m) => `${m.path}|${m.at}`));
let added = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    const info = classify(entry.name, ext);
    if (!info) continue;
    const stat = fs.statSync(full);
    if (known.has(`${full}|${stat.mtimeMs}`)) continue;
    logMedia({
      chatKey: OWNER_CHAT,
      direction: info.direction,
      kind: info.kind,
      name: entry.name,
      detail: info.detail,
      path: full,
      at: stat.mtimeMs,
    });
    added++;
  }
}

walk(FILES_DIR);
console.log(`backfilled ${added} files -> data/media-log.json`);
