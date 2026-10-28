import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'memory-global.json');

const DEFAULTS = {
  bot: { name: '小鲸鱼', alias: 'ojj' },
  owner: { name: 'Pay', aliases: ['爵士'], likes: ['打篮球'], relation: 'ojj 这个 agent 唯一的主人' },
  facts: [],
};

export function loadGlobal() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      bot: { ...DEFAULTS.bot, ...(raw.bot || {}) },
      owner: { ...DEFAULTS.owner, ...(raw.owner || {}) },
      facts: Array.isArray(raw.facts) ? raw.facts : [],
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveGlobal(g) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(g, null, 2), 'utf8');
}

/** “关于你自己和主人”的公开记忆，注入到所有会话（陌生人也看得到）。 */
export function formatGlobal() {
  const g = loadGlobal();
  const lines = ['【关于你自己和主人（可以对别人说）】'];
  if (g.bot?.name) lines.push(`- 你叫${g.bot.name}${g.bot.alias ? `，QQ 上叫 ${g.bot.alias}` : ''}。`);
  if (g.owner?.name) {
    const alias = (g.owner.aliases || []).filter(Boolean);
    lines.push(`- 你的主人叫 ${g.owner.name}${alias.length ? `，也可以叫他 ${alias.join('、')}` : ''}。`);
  }
  if (g.owner?.relation) {
    const rel = String(g.owner.relation);
    lines.push(`- ${rel.startsWith(g.owner.name) ? rel : `${g.owner.name} 是 ${rel}`}。`);
  }
  if (g.owner?.likes?.length) lines.push(`- 主人喜欢${g.owner.likes.join('、')}。`);
  for (const f of (g.facts || []).slice(-20)) lines.push(`- ${f}`);
  lines.push('- 这些是公开信息，可以自然地说出来；但你跟主人的具体聊天内容不要外传。');
  return lines.join('\n');
}

/** 追加一条公开事实（只有主人能调）。 */
export function addGlobalFact(text) {
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) return false;
  const g = loadGlobal();
  if ((g.facts || []).includes(clean)) return false;
  g.facts = [...(g.facts || []), clean].slice(-50);
  saveGlobal(g);
  return true;
}

/** 判断某个 QQ 是不是主人。 */
export function isOwner(userId, cfg) {
  const id = String(userId || '');
  if (!id) return false;
  const owner = String(cfg?.access?.ownerQQ || '');
  const admins = (cfg?.access?.adminQQ || []).map(String);
  return id === owner || admins.includes(id);
}
