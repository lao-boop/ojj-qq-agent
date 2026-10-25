import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const API = 'https://api.replicate.com/v1';

/**
 * Replicate 音乐生成（ACE-Step）。
 * 提交 prediction → 轮询 → 下载 mp3。
 */
export class SongGen {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.dir = path.join(DATA_DIR, 'audio');
    fs.mkdirSync(this.dir, { recursive: true });
    this.versionCache = '';
  }

  updateConfig(cfg) {
    this.cfg = cfg;
    this.versionCache = '';
  }

  get enabled() {
    return Boolean(this.cfg?.enabled && this.cfg?.token);
  }

  async #json(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error(`Replicate ${res.status}: ${(data?.detail || text).slice(0, 200)}`);
    return data;
  }

  /** 解析模型的最新版本号（有缓存）。 */
  async resolveVersion() {
    if (this.versionCache) return this.versionCache;
    const model = this.cfg.model || 'fishaudio/ace-step-1.5';
    const data = await this.#json(`${API}/models/${model}`);
    const id = data?.latest_version?.id;
    if (!id) throw new Error(`拿不到模型版本：${model}`);
    this.versionCache = id;
    return id;
  }

  /**
   * 生成一首歌，返回 { file, name, seconds, url, ms }。
   * lyrics 支持 [verse]/[chorus] 结构；style 是风格描述。
   */
  async generate({ lyrics, style, seconds = this.cfg.defaultSeconds || 30 }) {
    if (!this.enabled) throw new Error('没有配置 Replicate token');
    const dur = Math.min(Math.max(seconds, 10), this.cfg.maxSeconds || 60);
    const started = Date.now();
    const version = await this.resolveVersion();

    const input = {
      lyrics: String(lyrics || '').slice(0, 3000),
      prompt: String(style || 'gentle seaside folk, soft female vocal, acoustic guitar').slice(0, 400),
      duration: dur,
      thinking: true,
      batch_size: 1,
      audio_format: 'mp3',
      inference_steps: 8,
    };

    const created = await this.#json(`${API}/predictions`, {
      method: 'POST',
      body: JSON.stringify({ version, input }),
    });
    this.logger.info(`Replicate 任务已提交：${created.id}（${dur}s）`);

    const deadline = Date.now() + (this.cfg.timeoutMs || 300000);
    let prediction = created;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      prediction = await this.#json(`${API}/predictions/${created.id}`);
      if (prediction.status === 'succeeded') break;
      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        throw new Error(`生成失败：${(prediction.error || prediction.status).toString().slice(0, 200)}`);
      }
    }
    if (prediction.status !== 'succeeded') throw new Error('生成超时');

    const output = prediction.output;
    const url = Array.isArray(output) ? output[0] : typeof output === 'string' ? output : output?.audio || output?.url;
    if (!url) throw new Error('Replicate 没有返回音频地址');

    const audio = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!audio.ok) throw new Error(`下载音频失败 HTTP ${audio.status}`);
    const buf = Buffer.from(await audio.arrayBuffer());
    const name = `song-${Date.now()}.mp3`;
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, buf);
    this.logger.info(`歌曲生成完成 ${Math.round(buf.length / 1024)}KB，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, seconds: dur, url, bytes: buf.length, ms: Date.now() - started, predictionId: prediction.id };
  }
}
