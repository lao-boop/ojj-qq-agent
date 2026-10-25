import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const SESSION_DIR = path.join(DATA_DIR, 'sessions');

const emptySession = (key, title) => ({
  key,
  title: title || key,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  summary: '',
  notes: [],
  turns: [],
});

const fileFor = (key) => path.join(SESSION_DIR, `${crypto.createHash('sha1').update(key).digest('hex')}.json`);

/** 中文按字二元组切分，用来做相似度（不依赖外部向量服务）。 */
function bigrams(text) {
  const t = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const map = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    map.set(g, (map.get(g) || 0) + 1);
  }
  return map;
}

function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (!na || !nb) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const w = big.get(k);
    if (w) dot += v * w;
  }
  return dot / Math.sqrt(na * nb);
}

export class Memory {
  constructor({ logger, llm, cfg }) {
    this.logger = logger;
    this.llm = llm;
    this.cfg = cfg;
    this.cache = new Map();
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  get(key, title) {
    if (this.cache.has(key)) {
      const s = this.cache.get(key);
      if (title) s.title = title;
      return s;
    }
    const file = fileFor(key);
    let session;
    if (fs.existsSync(file)) {
      try {
        session = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        session = emptySession(key, title);
      }
    } else {
      session = emptySession(key, title);
    }
    session.turns ??= [];
    session.notes ??= [];
    if (title) session.title = title;
    this.cache.set(key, session);
    return session;
  }

  save(session) {
    session.updatedAt = Date.now();
    fs.writeFileSync(fileFor(session.key), JSON.stringify(session, null, 2), 'utf8');
  }

  append(key, role, content, title) {
    const session = this.get(key, title);
    session.turns.push({ role, content, ts: Date.now() });
    // storeAllTurns=true 时不再丢弃旧对话，全部留在会话文件里
    if (!this.cfg.storeAllTurns) {
      const maxTurns = Math.max(10, (this.cfg.historyTurns || 40) * 2);
      if (session.turns.length > maxTurns) session.turns = session.turns.slice(-maxTurns);
    }
    this.save(session);
    return session;
  }

  addNote(key, text, title) {
    const session = this.get(key, title);
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return false;
    if (session.notes.some((n) => n.text === clean)) return false;
    session.notes.push({ text: clean, ts: Date.now() });
    if (session.notes.length > 40) session.notes = session.notes.slice(-40);
    this.save(session);
    return true;
  }

  context(key, { title, query } = {}) {
    const session = this.get(key, title);
    const recent = session.turns.slice(-(this.cfg.historyTurns || 40));
    const result = {
      summary: session.summary,
      notes: session.notes.map((n) => n.text),
      turns: recent.map((t) => ({ role: t.role, content: t.content })),
      recalled: [],
    };

    // 简单检索：从更早的对话里按关键词捞相关片段，让“所有历史”也能被用到
    if (query && this.cfg.retrieval !== false) {
      const cutoff = session.turns.length - recent.length;
      const tokens = String(query)
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2)
        .slice(0, 12);
      if (tokens.length) {
        const scored = [];
        const qVec = bigrams(query);
        for (let i = 0; i < cutoff; i++) {
          const t = session.turns[i];
          if (!t?.content) continue;
          let score = 0;
          for (const k of tokens) if (t.content.includes(k)) score += k.length >= 3 ? 2 : 1;
          score += cosineSim(qVec, bigrams(t.content)) * 4;
          if (score >= 2) scored.push({ score, turn: t });
        }
        scored.sort((a, b) => b.score - a.score || (b.turn.ts || 0) - (a.turn.ts || 0));
        result.recalled = scored.slice(0, this.cfg.recallLimit || 6).map((s) => ({
          role: s.turn.role,
          content: String(s.turn.content).slice(0, 120),
        }));
      }
    }
    return result;
  }

  /** 用 flash 把一句话扩成关键词+同义词，弥补“换个说法就搜不到”。 */
  async expandTerms(query) {
    const base = String(query || '').trim();
    const tokens = base
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    if (!this.llm || this.cfg.expandQuery === false) return tokens.slice(0, 12);
    try {
      const res = await this.llm.chat({
        model: 'deepseek-flash',
        messages: [
          {
            role: 'system',
            content:
              '把用户这句话改写成 6~8 个用于检索的中文关键词和同义词，用空格分隔，只输出词，不要解释。' +
              '例如「睡不着」→「失眠 熬夜 睡不着 睡不好 深夜」。',
          },
          { role: 'user', content: base },
        ],
        maxTokens: 900,
        temperature: 0.2,
      });
      const extra = String(res.content || '')
        .split(/[\s,，、]+/)
        .filter((t) => t.length >= 2)
        .slice(0, 10);
      return [...new Set([...tokens, ...extra])].slice(0, 16);
    } catch {
      return tokens.slice(0, 12);
    }
  }

  /** 主动搜索这个会话的全部历史（含备注），给“翻旧账”用。 */
  async search(key, query, { limit = 8 } = {}) {
    const session = this.get(key);
    const terms = await this.expandTerms(query);
    if (!terms.length) return [];
    const qVec = bigrams(query);

    const hits = [];
    for (const t of session.turns || []) {
      if (!t?.content) continue;
      let score = 0;
      for (const k of terms) if (t.content.includes(k)) score += k.length >= 3 ? 2 : 1;
      score += cosineSim(qVec, bigrams(t.content)) * 4;
      if (score > 0) hits.push({ score, ts: t.ts || 0, role: t.role, content: String(t.content) });
    }
    for (const n of session.notes || []) {
      if (terms.some((k) => n.text.includes(k))) {
        hits.push({ score: 4, ts: n.ts || 0, role: 'note', content: n.text });
      }
    }
    hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
    const seen = new Set();
    const out = [];
    for (const h of hits) {
      const k = h.content.slice(0, 40);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
      if (out.length >= limit) break;
    }
    return out;
  }

  clear(key) {
    const session = emptySession(key, this.get(key).title);
    this.cache.set(key, session);
    this.save(session);
  }

  remove(key) {
    this.cache.delete(key);
    try {
      fs.unlinkSync(fileFor(key));
    } catch {
      /* ignore */
    }
  }

  list() {
    const out = [];
    for (const file of fs.readdirSync(SESSION_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), 'utf8'));
        out.push({
          key: s.key,
          title: s.title,
          turns: s.turns?.length ?? 0,
          notes: s.notes?.length ?? 0,
          updatedAt: s.updatedAt,
        });
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 历史太长时，把较早的对话压成一段摘要，避免上下文无限膨胀。 */
  async maybeSummarize(key) {
    // 保存全部历史时不再压缩：旧对话靠检索取回，不做摘要丢弃
    if (this.cfg.storeAllTurns) return false;
    const session = this.get(key);
    const chars = session.turns.reduce((n, t) => n + t.content.length, 0);
    if (chars < this.cfg.summaryTriggerChars || session.turns.length < 12) return false;
    const keep = 8;
    const old = session.turns.slice(0, -keep);
    const recent = session.turns.slice(-keep);
    if (old.length < 4) return false;
    const transcript = old.map((t) => `${t.role === 'user' ? '对方' : '小鲸鱼'}：${t.content}`).join('\n');
    try {
      const res = await this.llm.chat({
        messages: [
          {
            role: 'system',
            content:
              '你是对话记忆整理器。把下面这段聊天压缩成不超过 200 字的中文摘要，只保留：对方的关键信息、正在发生的事、情绪与关系进展。用第三人称陈述，不要评价，不要编造。',
          },
          { role: 'user', content: transcript },
        ],
        maxTokens: 400,
        temperature: 0.3,
      });
      const summary = (res.content || '').trim();
      if (!summary) return false;
      session.summary = [session.summary, summary].filter(Boolean).join('\n').slice(-1500);
      session.turns = recent;
      this.save(session);
      this.logger.info(`会话 ${key} 已压缩记忆（${old.length} 条 -> 摘要）`);
      return true;
    } catch (err) {
      this.logger.warn(`记忆压缩失败：${err.message}`);
      return false;
    }
  }
}
