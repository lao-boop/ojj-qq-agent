import fs from 'node:fs';
import { coverConfigurationIssue } from './cover-config.js';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const API = 'https://api.replicate.com/v1';

/**
 * RVC 翻唱/变声：把一段人声（或整首歌）换成目标声线。
 * 用 zsxkib/realistic-voice-cloning：内部先做人声分离再变声。
 */
export class VoiceConvert {
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
    return !this.configurationIssue;
  }

  get configurationIssue() {
    return coverConfigurationIssue(this.cfg);
  }

  get api() {
    return (this.cfg.apiBase || API).replace(/\/+$/, '');
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
    if (!res.ok) throw new Error(`Replicate ${res.status}: ${(data?.detail || text).slice(0, 200)}`);
    return data;
  }

  async resolveVersion() {
    if (this.cfg.version) return this.cfg.version;
    if (this.versionCache) return this.versionCache;
    const model = this.cfg.model || 'zsxkib/realistic-voice-cloning';
    const data = await this.#json(`${this.api}/models/${model}`);
    const id = data?.latest_version?.id;
    if (!id) throw new Error(`拿不到模型版本：${model}`);
    this.versionCache = id;
    return id;
  }

  async upload(audioPath) {
    const stat = fs.statSync(audioPath);
    const key = `${audioPath}:${stat.size}:${stat.mtimeMs}`;
    const cacheFile = path.join(DATA_DIR, 'cache', 'uploads.json');
    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      cache = {};
    }
    const cached = cache[key];
    if (cached?.url && cached.expiresAt > Date.now()) {
      this.logger.info('复用已上传的音频地址');
      return cached.url;
    }

    const buf = fs.readFileSync(audioPath);
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const form = new FormData();
        form.append('content', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioPath));
        const res = await fetch(`${this.api}/files`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.cfg.token}` },
          body: form,
          signal: AbortSignal.timeout(300000),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`上传音频失败 ${res.status}：${JSON.stringify(data).slice(0, 150)}`);
        const url = data?.urls?.get;
        if (!url) throw new Error('上传后没有拿到音频地址');
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        cache[key] = { url, expiresAt: Date.now() + 30 * 60 * 1000 };
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
        return url;
      } catch (err) {
        lastErr = err;
        this.logger.warn(`上传音频失败（第 ${attempt} 次）：${err.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw lastErr;
  }

  /** 变声，返回 { file, name, ms, voice }。 */
  async convert({ audioPath, voice, pitch, customModelUrl }) {
    if (!this.enabled) throw new Error(this.configurationIssue);
    if (!fs.existsSync(audioPath) || !fs.statSync(audioPath).size) throw new Error('待翻唱音频不存在或为空');
    const started = Date.now();
    const version = await this.resolveVersion();
    const audioUrl = await this.upload(audioPath);

    const customUrl = customModelUrl || this.cfg.customModelUrl || '';
    const rvcModel = customUrl ? 'CUSTOM' : voice || this.cfg.rvcModel || 'Drake';
    const input = {
      song_input: audioUrl,
      rvc_model: rvcModel,
      pitch_change: pitch || this.cfg.pitchChange || 'no-change',
      output_format: this.cfg.outputFormat || 'mp3',
      clean_audio: true,
    };
    if (customUrl) input.custom_rvc_model_download_url = customUrl;

    const created = await this.#json(`${this.api}/predictions`, {
      method: 'POST',
      body: JSON.stringify({ version, input }),
    });
    if (!created.id) throw new Error('翻唱服务未返回任务 ID；不会自动重提');
    this.logger.info(`变声任务已提交：${created.id}（${rvcModel}）`);

    const deadline = Date.now() + (this.cfg.timeoutMs || 300000);
    let pred = created;
    while (Date.now() < deadline && !['succeeded', 'failed', 'canceled'].includes(pred.status)) {
      await new Promise((r) => setTimeout(r, Math.max(50, this.cfg.pollIntervalMs || 5000)));
      try {
        pred = await this.#json(`${this.api}/predictions/${created.id}`);
      } catch (err) {
        this.logger.warn(`查询变声进度失败：${err.message}`);
        continue;
      }
      if (pred.status === 'succeeded') break;
      if (pred.status === 'failed' || pred.status === 'canceled') {
        throw new Error(`变声失败：${(pred.error || pred.status).toString().slice(0, 200)}`);
      }
    }
    if (['failed', 'canceled'].includes(pred.status)) throw new Error(`变声失败：${String(pred.error || pred.status).slice(0, 200)}`);
    if (pred.status !== 'succeeded') throw new Error(`翻唱结果未确认（任务 ${created.id}），请先查询该任务，避免重复提交`);

    const outUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!outUrl) throw new Error('没有返回音频');
    let audio;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        audio = await fetch(outUrl, { signal: AbortSignal.timeout(180000) });
        if (audio.ok) break;
        throw new Error(`HTTP ${audio.status}`);
      } catch (err) {
        if (attempt === 3) throw new Error(`下载变声结果失败：${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!audio?.ok) throw new Error('下载翻唱结果失败');
    const buf = Buffer.from(await audio.arrayBuffer());
    if (buf.length < 1000 || /(?:json|text\/|html)/i.test(audio.headers.get('content-type') || '')) throw new Error('翻唱服务返回的不是有效音频文件');
    const name = `cover-${Date.now()}.mp3`;
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, buf);
    this.logger.info(`变声完成 ${Math.round(buf.length / 1024)}KB，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, bytes: buf.length, ms: Date.now() - started, voice: rvcModel };
  }
}
