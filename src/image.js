import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, ROOT } from './config.js';
import { ffmpegBin } from './media.js';

const execFileAsync = promisify(execFile);

/** 用 ffmpeg delogo 抹掉右下角的水印。 */
async function removeLogo(file, width, height) {
  const x = Math.max(0, Math.round(width * 0.72));
  const y = Math.max(0, Math.round(height * 0.925));
  const w = Math.min(width - x, Math.round(width * 0.27));
  const h = Math.min(height - y, Math.round(height * 0.072));
  const tmp = file.replace(/(\.[a-z]+)$/i, '-clean$1');
  await execFileAsync(
    ffmpegBin(process.env.FFMPEG_PATH),
    ['-y', '-loglevel', 'error', '-i', file, '-vf', `delogo=x=${x}:y=${y}:w=${w}:h=${h}`, '-q:v', '2', tmp],
    { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) throw new Error('没有产出处理后的图片');
  fs.renameSync(tmp, file);
}

/**
 * 出图。支持三种后端：
 *  - pollinations：免费、免注册，但同一 IP 45 秒只能出一张，最大 768x768
 *  - siliconflow：硅基流动，需要 key，FLUX.1-schnell 免费额度，速度快
 *  - openai：任意 OpenAI 兼容的 /images/generations 接口
 */
export class ImageGen {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.dir = path.join(DATA_DIR, 'images');
    fs.mkdirSync(this.dir, { recursive: true });
    this.chain = Promise.resolve();
  }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  static areaLimit(input, provider) {
    const max = provider === 'pollinations' ? 768 : 1536;
    const presets = {
      square: [max, max],
      portrait: [Math.round((max * 0.78) / 8) * 8, max],
      landscape: [max, Math.round((max * 0.78) / 8) * 8],
      wide: [max, Math.round((max * 0.6) / 8) * 8],
      tall: [Math.round((max * 0.6) / 8) * 8, max],
    };
    if (!input) return presets.square;
    if (presets[input]) return presets[input];
    const m = /^(\d{2,4})\s*[x×*]\s*(\d{2,4})$/i.exec(String(input).trim());
    if (m) {
      const w = Math.min(Number(m[1]) || max, max);
      const h = Math.min(Number(m[2]) || max, max);
      return [Math.round(w / 8) * 8, Math.round(h / 8) * 8];
    }
    if (input === 'square') return presets.square;
    return presets.square;
  }

  /** 串行化，避免并发打爆上游（pollinations 同时只允许一张）。 */
  generate(opts) {
    const run = () => this.#generate(opts);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async #generate({ prompt, size = this.cfg.defaultSize, seed }) {
    if (!this.cfg.enabled) throw new Error('出图功能已关闭');
    const clean = String(prompt || '').trim().slice(0, this.cfg.maxPromptChars);
    if (!clean) throw new Error('空提示词');
    const provider = this.cfg.provider || 'pollinations';
    const [width, height] = ImageGen.areaLimit(size, provider);
    const started = Date.now();

    let buffer;
    let ext = 'jpg';
    const attempts = provider === 'pollinations' ? 3 : 2;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const data = await this.#callProvider(provider, clean, width, height, seed);
        buffer = data.buffer;
        ext = data.ext;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err.retryAfter) throw err; // 免费额度用完，重试也没用
        this.logger.warn(`出图第 ${i + 1} 次失败：${err.message}`);
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    if (lastErr) throw lastErr;

    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, buffer);

    // pollinations 会在右下角烧一个 logo，用 delogo 抹掉（可关）
    if (provider === 'pollinations' && this.cfg.removeWatermark !== false) {
      try {
        await removeLogo(file, width, height);
      } catch (err) {
        this.logger.warn(`去水印失败（保留原图）：${err.message}`);
      }
    }

    this.logger.info(`出图完成(${provider}) ${width}x${height} ${Math.round(buffer.length / 1024)}KB ${Date.now() - started}ms`);
    return { file, name, width, height, bytes: buffer.length, prompt: clean, provider };
  }

  async #callProvider(provider, prompt, width, height, seed) {
    if (provider === 'pollinations') return this.#pollinations(prompt, width, height, seed);
    if (provider === 'replicate') return this.#replicate(prompt, width, height, seed);
    if (provider === 'siliconflow') return this.#siliconflow(prompt, width, height, seed);
    if (provider === 'openai') return this.#openai(prompt, width, height, seed);
    if (provider === 'mock') {
      return { buffer: fs.readFileSync(path.join(ROOT, 'assets', 'sample-image.jpg')), ext: 'jpg' };
    }
    throw new Error(`不认识的出图后端：${provider}`);
  }

  /** Replicate 上的 FLUX（无水印，按张计费）。 */
  async #replicate(prompt, width, height, seed) {
    const token = this.cfg.apiKey || process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error('缺少 Replicate token');
    const model = this.cfg.model || 'black-forest-labs/flux-1.1-pro';
    const ratio = width > height * 1.2 ? '16:9' : height > width * 1.2 ? '9:16' : '1:1';

    let input;
    if (/flux-1\.1-pro|flux-pro/i.test(model)) {
      input = {
        prompt,
        aspect_ratio: ratio,
        output_format: 'jpg',
        output_quality: 92,
        safety_tolerance: 2,
      };
    } else if (/flux-dev/i.test(model)) {
      input = {
        prompt,
        aspect_ratio: ratio,
        output_format: 'jpg',
        output_quality: 92,
        num_outputs: 1,
        num_inference_steps: 28,
        guidance: 3.5,
      };
    } else {
      input = {
        prompt,
        aspect_ratio: ratio,
        output_format: 'jpg',
        output_quality: 90,
        num_outputs: 1,
        go_fast: true,
      };
    }
    if (seed) input.seed = seed;

    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const created = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ input }),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(`Replicate ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
      return data;
    });

    const deadline = Date.now() + (this.cfg.timeoutMs || 180000);
    let pred = created;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      pred = await fetch(`https://api.replicate.com/v1/predictions/${created.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      if (pred.status === 'succeeded') break;
      if (pred.status === 'failed' || pred.status === 'canceled') {
        throw new Error(`出图失败：${(pred.error || pred.status).toString().slice(0, 160)}`);
      }
    }
    if (pred.status !== 'succeeded') throw new Error('出图超时');

    const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!url) throw new Error('没有返回图片地址');
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, ext: 'jpg' };
  }

  async #pollinations(prompt, width, height, seed) {
    const url = new URL(this.cfg.baseUrl + encodeURIComponent(prompt));
    url.searchParams.set('width', String(width));
    url.searchParams.set('height', String(height));
    url.searchParams.set('seed', String(seed ?? Math.floor(Math.random() * 1e9)));
    url.searchParams.set('nologo', 'true');
    if (this.cfg.apiKey) url.searchParams.set('token', this.cfg.apiKey);

    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
      headers: { Accept: 'image/*' },
    });
    if (res.status === 402) {
      const retry = Number(res.headers.get('retry-after')) || 45;
      const err = new Error(`免费出图额度用完了，大约 ${retry} 秒后才能再画一张`);
      err.retryAfter = retry;
      throw err;
    }
    if (!res.ok) throw new Error(`出图接口 HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) throw new Error(`出图接口返回了非图片内容（${type}）`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 2000) throw new Error('出图接口返回的图片过小');
    return { buffer, ext: type.includes('png') ? 'png' : 'jpg' };
  }

  async #siliconflow(prompt, width, height, seed) {
    if (!this.cfg.apiKey) throw new Error('硅基流动需要填 key');
    const base = (this.cfg.apiBase || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model || 'black-forest-labs/FLUX.1-schnell',
        prompt,
        image_size: `${width}x${height}`,
        batch_size: 1,
        num_inference_steps: 8,
        seed: seed ?? Math.floor(Math.random() * 1e9),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`硅基流动 HTTP ${res.status}：${(await res.text()).slice(0, 160)}`);
    const json = await res.json();
    const url = json?.images?.[0]?.url || json?.data?.[0]?.url;
    if (!url) throw new Error('硅基流动没有返回图片地址');
    const img = await fetch(url, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!img.ok) throw new Error(`下载生成图失败 HTTP ${img.status}`);
    return { buffer: Buffer.from(await img.arrayBuffer()), ext: 'jpg' };
  }

  async #openai(prompt, width, height, seed) {
    if (!this.cfg.apiKey) throw new Error('出图接口需要填 key');
    const base = (this.cfg.apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        model: this.cfg.model || 'gpt-image-1',
        prompt,
        size: `${width}x${height}`,
        n: 1,
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`出图接口 HTTP ${res.status}：${(await res.text()).slice(0, 160)}`);
    const json = await res.json();
    const item = json?.data?.[0];
    if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), ext: 'png' };
    if (item?.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      return { buffer: Buffer.from(await img.arrayBuffer()), ext: 'png' };
    }
    throw new Error('出图接口没有返回图片');
  }
}
