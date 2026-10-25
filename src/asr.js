import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as OpenCC from 'opencc-js';
import { DATA_DIR } from './config.js';

const API = 'https://api.replicate.com/v1';
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });

/** 只保留汉字/字母/数字，去掉标点空格，统一成简体。 */
export function normalizeChars(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** 在逐字带时间戳的歌词里找最像的一句，返回开始时间。 */
export function alignFromWords(words, phrase) {
  const chars = [];
  for (const w of words) {
    const raw = String(w.word || '');
    const simplified = toSimplified(raw);
    for (const ch of normalizeChars(simplified)) {
      chars.push({ ch, start: w.start, end: w.end });
    }
  }
  const query = normalizeChars(toSimplified(phrase));
  if (!chars.length || !query) return null;
  const stream = chars.map((c) => c.ch).join('');

  let best = null;
  const L = query.length;
  for (let len = Math.max(2, L - 2); len <= L + 4; len++) {
    for (let i = 0; i + len <= stream.length; i++) {
      const window = stream.slice(i, i + len);
      const dist = levenshtein(query, window);
      const score = 1 - dist / Math.max(L, len);
      if (!best || score > best.score) {
        best = { score, index: i, length: len, text: window };
      }
    }
  }
  if (!best || best.score < 0.45) return null;
  const startChar = chars[best.index];
  const endChar = chars[Math.min(chars.length - 1, best.index + best.length - 1)];
  return {
    start: Math.max(0, Number(startChar.start) - 0.4),
    end: Number(endChar.end),
    score: best.score,
    matched: best.text,
  };
}

/**
 * 用 Replicate WhisperX 给整首歌做逐字时间戳，按歌词句子定位开始时间。
 * 结果按文件缓存，同一首歌只花一次钱。
 */
export class Aligner {
  constructor(cfg, logger) {
    this.cfg = cfg || {};
    this.logger = logger;
    this.dir = path.join(DATA_DIR, 'asr');
    fs.mkdirSync(this.dir, { recursive: true });
    this.versionCache = '';
  }

  updateConfig(cfg) {
    this.cfg = cfg || {};
    this.versionCache = '';
  }

  get enabled() {
    return Boolean(this.cfg?.enabled !== false && this.cfg?.token);
  }

  #cachePath(file) {
    const stat = fs.statSync(file);
    const key = crypto.createHash('sha1').update(`${file}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
    return path.join(this.dir, `${key}.json`);
  }

  async #json(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error(`Replicate ${res.status}: ${(data?.detail || text).slice(0, 160)}`);
    return data;
  }

  async #resolveVersion() {
    if (this.versionCache) return this.versionCache;
    const model = this.cfg.model || 'victor-upmeet/whisperx';
    const data = await this.#json(`${API}/models/${model}`);
    const id = data?.latest_version?.id;
    if (!id) throw new Error('拿不到 WhisperX 版本');
    this.versionCache = id;
    return id;
  }

  async #upload(audioPath) {
    const buf = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append('content', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioPath));
    const res = await fetch(`${API}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      body: form,
      signal: AbortSignal.timeout(300000),
    });
    const data = await res.json();
    const url = data?.urls?.get;
    if (!res.ok || !url) throw new Error(`上传失败 ${res.status}`);
    return url;
  }

  /** 拿到逐字时间戳（有缓存）。 */
  async wordsFor(audioPath) {
    if (!this.enabled) throw new Error('ASR 未配置');
    const cache = this.#cachePath(audioPath);
    if (fs.existsSync(cache)) {
      try {
        return JSON.parse(fs.readFileSync(cache, 'utf8')).words || [];
      } catch {
        /* 缓存坏了就重跑 */
      }
    }
    const url = await this.#upload(audioPath);
    const version = await this.#resolveVersion();
    const created = await this.#json(`${API}/predictions`, {
      method: 'POST',
      body: JSON.stringify({
        version,
        input: { audio_file: url, language: 'zh', align_output: true, batch_size: 16, task: 'transcribe' },
      }),
    });
    this.logger.info(`WhisperX 任务已提交：${created.id}`);
    const deadline = Date.now() + 600000;
    let pred = created;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      pred = await this.#json(`${API}/predictions/${created.id}`);
      if (pred.status === 'succeeded') break;
      if (pred.status === 'failed' || pred.status === 'canceled') {
        throw new Error(`WhisperX 失败：${(pred.error || pred.status).toString().slice(0, 160)}`);
      }
    }
    if (pred.status !== 'succeeded') throw new Error('WhisperX 超时');
    const segments = pred.output?.segments || [];
    const words = segments.flatMap((s) => s.words || []);
    fs.writeFileSync(cache, JSON.stringify({ source: audioPath, words }, null, 0));
    this.logger.info(`WhisperX 完成：${words.length} 个字`);
    return words;
  }

  /** 只转写、不做逐字对齐（语音聊天用，比 wordsFor 快）。 */
  async transcribeFast(audioPath) {
    if (!this.enabled) throw new Error('ASR 未配置');
    const cache = this.#cachePath(audioPath).replace(/\.json$/, '-text.json');
    if (fs.existsSync(cache)) {
      try {
        return JSON.parse(fs.readFileSync(cache, 'utf8')).text || '';
      } catch {
        /* 重跑 */
      }
    }
    const url = await this.#upload(audioPath);
    const version = await this.#resolveVersion();
    const created = await this.#json(`${API}/predictions`, {
      method: 'POST',
      body: JSON.stringify({
        version,
        input: { audio_file: url, language: 'zh', align_output: false, batch_size: 24, task: 'transcribe' },
      }),
    });
    this.logger.info(`语音转写任务已提交：${created.id}`);
    const deadline = Date.now() + 600000;
    let pred = created;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      pred = await this.#json(`${API}/predictions/${created.id}`);
      if (pred.status === 'succeeded') break;
      if (pred.status === 'failed' || pred.status === 'canceled') {
        throw new Error(`转写失败：${(pred.error || pred.status).toString().slice(0, 160)}`);
      }
    }
    if (pred.status !== 'succeeded') throw new Error('转写超时');
    const segments = pred.output?.segments || [];
    const text = segments.map((s) => s.text || '').join('').replace(/\s+/g, '').trim();
    fs.writeFileSync(cache, JSON.stringify({ source: audioPath, text }, null, 0));
    this.logger.info(`语音转写完成：${text.slice(0, 40)}`);
    return text;
  }

  /** 定位某句歌词在歌里的开始时间。 */
  async findLineStart(audioPath, phrase) {
    const words = await this.wordsFor(audioPath);
    const hit = alignFromWords(words, phrase);
    if (hit) this.logger.info(`定位到「${phrase}」→ ${hit.start.toFixed(1)}s（相似度 ${hit.score.toFixed(2)}）`);
    return hit;
  }
}
