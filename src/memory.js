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

export const memoryScopeKey = (key, actorId) => String(key).startsWith('group:') ? `${key}:actor:${actorId || 'unknown'}` : key;

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
  constructor({ logger, llm, cfg, directory = SESSION_DIR, now = () => Date.now() }) {
    this.logger = logger;
    this.llm = llm;
    this.cfg = cfg;
    this.cache = new Map();
    this.directory = directory;
    this.now = now;
    fs.mkdirSync(directory, { recursive: true });
  }

  fileFor(key) { return path.join(this.directory, `${crypto.createHash('sha1').update(key).digest('hex')}.json`); }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  get(key, title) {
    if (this.cache.has(key)) {
      const s = this.cache.get(key);
      if (title) s.title = title;
      return s;
    }
    const file = this.fileFor(key);
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
    session.notes = session.notes.map(n => ({ ...n, id: n.id || crypto.randomUUID(), scope: n.scope || 'permanent', expiresAt:n.expiresAt ?? null }));
    session.hiddenTurns ??= [];
    if (title) session.title = title;
    this.cache.set(key, session);
    return session;
  }

  save(session) {
    session.updatedAt = this.now();
    const file = this.fileFor(session.key), tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { encoding:'utf8', mode:0o600 });
    fs.renameSync(tmp, file);
  }

  append(key, role, content, title, { requestId, memoryIds = [] } = {}) {
    const session = this.get(key, title);
    session.turns.push({ role, content, ts: this.now(), ...(requestId ? { requestId, memoryIds } : {}) });
    // storeAllTurns=true 时不再丢弃旧对话，全部留在会话文件里
    if (!this.cfg.storeAllTurns) {
      const maxTurns = Math.max(10, (this.cfg.historyTurns || 40) * 2);
      if (session.turns.length > maxTurns) session.turns = session.turns.slice(-maxTurns);
    }
    this.save(session);
    return session;
  }

  addNote(key, text, title, options = {}) {
    const session = this.get(key, title);
    const clean = this.noteText(text);
    if (!clean) return false;
    const policy = this.notePolicy(options);
    if (this.activeNotes(session).some(n => n.text === clean && n.scope === policy.scope && n.expiresAt === policy.expiresAt)) return false;
    session.notes.push({ id:crypto.randomUUID(), text:clean, ts:this.now(), ...policy, requestId:options.requestId || '' });
    // Storage is not a prompt window: never discard saved facts to bound model input.
    this.save(session);
    return true;
  }

  noteText(text) {
    const clean = String(text || '').trim();
    if (clean.length > 600) throw new Error('单条记忆过长，请拆分保存，不会截断内容');
    return clean;
  }

  notePolicy({ scope = 'permanent', expiresAt } = {}) {
    if (!['permanent','temporary'].includes(scope)) throw new Error('记忆类型只能是长期或有期限的临时记录');
    if (scope === 'temporary') {
      if (typeof expiresAt !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now()) throw new Error('临时记忆需要明确且尚未到期的含时区截止时间');
      return { scope, expiresAt:new Date(expiresAt).toISOString() };
    }
    if (expiresAt) throw new Error('长期记忆不应附带过期时间');
    return { scope, expiresAt:null };
  }

  activeNotes(session) {
    this.expireNotes(session);
    return session.notes;
  }

  expireNotes(session) {
    const expired = session.notes.filter(n => n.scope === 'temporary' && Date.parse(n.expiresAt) <= this.now());
    if (!expired.length) return;
    for (const note of expired) this.retire(session, note);
    const ids = new Set(expired.map(n => n.id));
    session.notes = session.notes.filter(n => !ids.has(n.id));
    // Tombstones outlive the note itself, including restarts and later capacity changes.
    this.save(session);
  }

  selectNotes(session, query = '', limit = 40) {
    const active = this.activeNotes(session), q = String(query).trim(), vector = bigrams(q);
    if(!q)return active.slice(-limit);
    return active.map((note,index) => ({note,index,score:q ? cosineSim(vector,bigrams(note.text)) + (note.text.includes(q) ? 1 : 0) : 0}))
      .sort((a,b) => b.score-a.score || b.index-a.index).slice(0,limit).map(r=>r.note);
  }

  searchNotes(key, query, { limit = 20, offset = 0 } = {}) {
    const session = this.get(key), active = this.activeNotes(session);
    const matches = query ? this.selectNotes(session,query,active.length).filter(n=>cosineSim(bigrams(query),bigrams(n.text)) > 0 || n.text.includes(query)) : active;
    return { total:active.length, matches:matches.length, records:matches.slice(offset,offset+limit).map(({id,text,scope,expiresAt})=>({id,text,scope,expiresAt})), nextOffset:offset+limit<matches.length ? offset+limit : null };
  }

  visibleTurns(session) {
    this.expireNotes(session);
    const hidden = new Set(session.hiddenTurns || []);
    const retired = new Set(session.retiredNoteIds || []);
    for (const n of session.notes) if (n.scope === 'temporary' && Date.parse(n.expiresAt) <= this.now() && n.requestId) hidden.add(n.requestId);
    for (const n of session.notes) if (n.scope === 'temporary' && Date.parse(n.expiresAt) <= this.now()) retired.add(n.id);
    return session.turns.filter(t => !hidden.has(t.requestId) && !(t.memoryIds || []).some(id => retired.has(id)) && (!session.legacyMemoryCutoff || t.ts > session.legacyMemoryCutoff));
  }

  retire(session, note, requestId) {
    session.retiredNoteIds = [...new Set([...(session.retiredNoteIds || []), note.id])];
    session.hiddenTurns ||= [];
    if (note.requestId) session.hiddenTurns.push(note.requestId);
    else session.legacyMemoryCutoff = Math.max(session.legacyMemoryCutoff || 0, note.ts || this.now());
    if (requestId) session.hiddenTurns.push(requestId);
    session.hiddenTurns = [...new Set(session.hiddenTurns)];
    session.summary = ''; // A compressed summary has no per-fact provenance.
  }

  updateNote(key, id, text, options = {}) {
    const session = this.get(key), note = this.activeNotes(session).find(n => n.id === id);
    if (!note) throw new Error('没有找到当前用户的这条有效记忆，请先核对要修改的记录');
    const clean = this.noteText(text);
    if (!clean) throw new Error('更正后的记忆不能为空');
    const scope = options.scope || note.scope;
    const policy = this.notePolicy({ scope, expiresAt:scope === 'permanent' ? undefined : options.expiresAt ?? note.expiresAt });
    this.retire(session, note);
    Object.assign(note, { id:crypto.randomUUID(), text:clean, ts:this.now(), ...policy, requestId:options.requestId || '' });
    this.save(session); return true;
  }

  forgetNote(key, id, { requestId } = {}) {
    const session = this.get(key), note = session.notes.find(n => n.id === id);
    if (!note) throw new Error('没有找到当前用户的这条记忆，不会删除其他记录');
    this.retire(session, note, requestId);
    session.notes = session.notes.filter(n => n.id !== id);
    this.save(session); return true;
  }

  context(key, { title, query } = {}) {
    const session = this.get(key, title);
    const visible = this.visibleTurns(session);
    const recent = visible.slice(-(this.cfg.historyTurns || 40));
    const active = this.selectNotes(session, query);
    const result = {
      summary: session.summary,
      notes: active.map((n) => n.text),
      noteRecords: active.map(({id,text,scope,expiresAt}) => ({id,text,scope,expiresAt})),
      noteCount: session.notes.length,
      notesPartial: session.notes.length > active.length,
      turns: recent.map((t) => ({ role: t.role, content: t.content })),
      recalled: [],
    };

    // 简单检索：从更早的对话里按关键词捞相关片段，让“所有历史”也能被用到
    if (query && this.cfg.retrieval !== false) {
      const cutoff = visible.length - recent.length;
      const tokens = String(query)
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2)
        .slice(0, 12);
      if (tokens.length) {
        const scored = [];
        const qVec = bigrams(query);
        for (let i = 0; i < cutoff; i++) {
          const t = visible[i];
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
    for (const t of this.visibleTurns(session)) {
      if (!t?.content) continue;
      let score = 0;
      for (const k of terms) if (t.content.includes(k)) score += k.length >= 3 ? 2 : 1;
      score += cosineSim(qVec, bigrams(t.content)) * 4;
      if (score > 0) hits.push({ score, ts: t.ts || 0, role: t.role, content: String(t.content) });
    }
    for (const n of this.activeNotes(session)) {
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
      fs.unlinkSync(this.fileFor(key));
    } catch {
      /* ignore */
    }
  }

  list() {
    const out = [];
    for (const file of fs.readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.directory, file), 'utf8'));
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
    const visible = this.visibleTurns(session);
    // Expiring facts must not outlive their source in a compressed summary.
    if (session.notes.some(n => n.scope === 'temporary')) return false;
    const old = visible.slice(0, -keep);
    const recent = visible.slice(-keep);
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
