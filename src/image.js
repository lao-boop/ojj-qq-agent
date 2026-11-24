import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, ROOT, loadConfig } from './config.js';
import { LLM } from './llm.js';
import { toImagePrompt } from './image-prompt.js';
import { ffmpegBin } from './media.js';

const execFileAsync = promisify(execFile);
const readImage = url => readReplicate(url, {}, async res => Buffer.from(await res.arrayBuffer()));

async function scarfContour(buffer, color) {
  const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const python = process.env.PYTHON_PATH || (fs.existsSync(bundled) ? bundled : 'python');
  const result = execFileAsync(python, [path.join(ROOT, 'scripts', 'scarf_contour.py'), color], {
    timeout: 15000, windowsHide: true,
  });
  result.child.stdin.on('error', () => {}); // The process promise reports startup and pipe failures.
  result.child.stdin.end(buffer);
  return (await result).stdout.trim();
}
let nextPredictionAt = 0;
let predictionInterval = 0;

async function readReplicate(url, options, decode) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
      if (!res.ok) {
        const err = new Error(`Replicate 读取失败：HTTP ${res.status}`);
        err.permanent = res.status < 500 && ![408,429].includes(res.status);
        throw err;
      }
      return await decode(res);
    } catch (err) {
      if (err.permanent || attempt >= 4) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

async function createPrediction(model, input, token) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const start = Math.max(Date.now(), nextPredictionAt);
    nextPredictionAt = start + predictionInterval;
    if (start > Date.now()) await new Promise(resolve => setTimeout(resolve, start - Date.now()));
    let res;
    try {
      res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      const beforeConnect = ['EAI_AGAIN','ENOTFOUND','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(err.cause?.code);
      if (!beforeConnect || attempt === 5) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    const data = await res.json();
    if (res.ok) return data;
    if (res.status === 429) {
      const perMinute = Number(String(data.detail).match(/(\d+) requests per minute/i)?.[1]);
      if (perMinute) predictionInterval = Math.ceil(60000 / perMinute) + 500;
      const seconds = Number(res.headers.get('retry-after') || data.retry_after || 10);
      nextPredictionAt = Math.max(nextPredictionAt, Date.now() + (Number.isFinite(seconds) ? seconds : 10) * 1000 + 500);
      continue;
    }
    const err = new Error(`Replicate ${res.status}: ${String(data.detail || '').slice(0,180)}`);
    if (res.status === 402 || res.status === 401 || res.status === 403) err.terminal = true;
    throw err;
  }
  throw new Error('Replicate 持续限流，请稍后再试');
}

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

  async #generate({ prompt, size, seed, format, prepared = false, originalPrompt }) {
    if (!this.cfg.enabled) throw new Error('出图功能已关闭');
    const request = String(originalPrompt ?? prompt ?? '').trim().slice(0, this.cfg.maxPromptChars);
    const clean = prepared ? String(prompt || '').trim() : request;
    if (!clean) throw new Error('空提示词');
    const provider = this.cfg.provider || 'pollinations';
    const requestedFormat = format || (/\bpng\b/i.test(request) ? 'png' : 'jpg');
    let description = clean;
    if (provider === 'replicate' && !prepared && /[\u4e00-\u9fff]/.test(clean)) {
      const cfg = loadConfig().llm;
      if (cfg.apiKey) description = await toImagePrompt(new LLM(cfg, this.logger), clean, this.logger, cfg.helperModel);
    }
    const inferredSize = /横版|横屏/.test(request) ? 'wide' : /竖版|竖屏/.test(request) ? 'tall' : this.cfg.defaultSize;
    const [width, height] = ImageGen.areaLimit(size || inferredSize, provider);
    const started = Date.now();

    let buffer;
    let reviewed = false;
    let ext = 'jpg';
    const attempts = provider === 'pollinations' ? 3 : 2;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const data = await this.#callProvider(provider, description, width, height, seed, requestedFormat, request);
        reviewed = Boolean(data.reviewed);
        buffer = data.buffer;
        ext = data.ext;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (err.retryAfter || err.qualityRejected || err.terminal) throw err;
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
    return { file, name, width, height, bytes: buffer.length, prompt: clean, provider, reviewed };
  }

  async #callProvider(provider, prompt, width, height, seed, format, request) {
    if (provider === 'pollinations') return this.#pollinations(prompt, width, height, seed);
    if (provider === 'replicate') return this.#replicate(prompt, width, height, seed, format, request);
    if (provider === 'siliconflow') return this.#siliconflow(prompt, width, height, seed);
    if (provider === 'openai') return this.#openai(prompt, width, height, seed);
    if (provider === 'mock') {
      return { buffer: fs.readFileSync(path.join(ROOT, 'assets', 'sample-image.jpg')), ext: 'jpg' };
    }
    throw new Error(`不认识的出图后端：${provider}`);
  }

  /** Replicate 上的 FLUX（无水印，按张计费）。 */
  async #replicate(prompt, width, height, seed, format, request) {
    const token = this.cfg.apiKey || process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error('缺少 Replicate token');
    let model = this.cfg.model || 'black-forest-labs/flux-2-pro';
    const ratio = width > height * 1.2 ? '16:9' : height > width * 1.2 ? '9:16' : '1:1';

    let input;
    if (/flux-1\.1-pro|flux-2-(pro|max)|flux-pro/i.test(model)) {
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
    input.output_format = format === 'png' ? 'png' : 'jpg';
    if (seed != null) input.seed = seed;

    const reviewModel = this.cfg.reviewModel;
    const mentionsScarf = /围巾|圍巾|\b(?:scarf|scarves)\b/i.test(request);
    const scarfPlacement = 'For a scarf worn around the neck, render a continuous collar: show the band crossing the visible SIDE of the neck from its upper outline to the throat, behind the jaw and in front of the shoulder or forefin. Keep the mouth clear. Connect the loose ends to this same band. Follow the requested placement if it is worn differently or not worn.';
    if (mentionsScarf) input.prompt += '\n' + scarfPlacement +
      ' For a side-view animal, show a broad strip of the collar breaking the upper neck silhouette immediately behind the head. Let the band cross the visible neck downward to one hanging knot; leave the flank and pectoral fin unobstructed.';
    const supportsEdit = /\/flux-2-(max|pro)$/.test(model);
    let url;
    const initialModel = model;
    const initialInput = { ...input };
    let best;
    let acceptedBuffer;
    let editsWithoutImprovement = 0;
    const maxDraws = 8;
    for (let draw = 0; draw < maxDraws; draw++) {
      const output = await this.#prediction(model, input, token);
      url = Array.isArray(output) ? output[0] : output;
      if (!url || !reviewModel) break;
      const verdict = await this.#reviewImage(reviewModel, url, request, token, mentionsScarf);
      if (verdict.pass) {
        if (!mentionsScarf || verdict.scarf_attachment !== 'neck_wrap' || !verdict.contour_color) break;
        const candidate = await readImage(url);
        let position;
        try {
          position = await scarfContour(candidate, verdict.contour_color);
          this.logger.debug?.('围巾轮廓检查：' + position);
        } catch (err) {
          this.logger.warn('围巾轮廓像素检查不可用：' + err.message);
        }
        if (position !== 'below') {
          acceptedBuffer = candidate;
          break;
        }
        verdict.fixes.push('The neck outline is uninterrupted above the cloth. Remove the cloth from the flank and chin. Place the top of a broad collar directly on the upper neck silhouette behind the head and connect it to the lower knot.');
      }
      const freshDraw = !input.input_images && !input.image_input;
      if (!best || verdict.fixes.length < best.fixes.length ||
          (freshDraw && verdict.fixes.length === best.fixes.length)) {
        best = { url, fixes: verdict.fixes };
        editsWithoutImprovement = 0;
      } else {
        editsWithoutImprovement++;
      }
      if (draw + 1 === maxDraws) {
        const err = new Error(`生成的图片连续 ${maxDraws} 次未通过画面要求核验`);
        err.qualityRejected = true;
        throw err;
      }
      const repairWithNano = this.cfg.repairModel === 'google/nano-banana-2' && seed == null;
      const issue = best.fixes.join('\n').slice(0, 1500);
      const editPrompt = 'Edit the reference image. Apply these corrections and preserve the already correct details:\n' +
        issue + '\nDesired scene: ' + initialInput.prompt;
      if (editsWithoutImprovement >= 2 || !(repairWithNano || supportsEdit)) {
        model = initialModel;
        input = { ...initialInput, prompt: initialInput.prompt + '\nPay particular attention to these requirements:\n' + issue };
        editsWithoutImprovement = 0;
      } else if (repairWithNano) {
        model = this.cfg.repairModel;
        input = {
          aspect_ratio: ratio, output_format: format === 'png' ? 'png' : 'jpg',
          resolution: '1K', image_input: [best.url], prompt: editPrompt,
        };
      } else {
        input = { ...initialInput, input_images: [best.url], prompt: editPrompt };
      }
      if (seed != null) input.seed = (Number(seed) + draw + 1) >>> 0;
    }
    if (!url) throw new Error('没有返回图片地址');
    const buf = acceptedBuffer || await readImage(url);
    const png = buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (format === 'png' && !png) throw new Error('生图服务返回的编码与请求的 PNG 不一致');
    return { buffer: buf, ext: png ? 'png' : 'jpg', reviewed: Boolean(reviewModel) };
  }

  async #reviewImage(model, url, request, token, mentionsScarf) {
    const input = {
      images: [url], prompt: request, temperature: 0, max_output_tokens: 1200,
      system_instruction: 'Judge visible pixels against the original request. Check subjects, counts, positions, colors, background and text. Verify that each accessory is attached to the intended wearer and body part. For a neck scarf, fabric on the forehead or back fails. Accept any pose, knot or style consistent with the request. Ignore file encoding. List each unmet requirement once, with the needed change in English. Return only JSON: {"pass":boolean,"fixes":["actionable change"]}. Pass only when all requirements are met and fixes is empty.',
    };
    if (mentionsScarf) {
      input.system_instruction += ' Include "contour_color": use a six-digit #RRGGBB estimate of the main scarf fabric only for a neck-worn scarf on a side-profile, horizontally posed animal with a visible upper neck, flat illustration, solid background, and contrasting scarf color not shared by the background. Otherwise use null. Inspect the upper neck boundary behind the head first; cloth entirely beneath an uninterrupted body-colored neck outline is misplaced.';
      input.system_instruction += ' Include a "scarf_attachment" field. Use "other_request" only when the original request does not ask for a neck-worn scarf. Otherwise trace the band across the visible side of the neck between the head and torso. Use "neck_wrap" when you see it encircle that junction. Use "misplaced" if it only lies along the flank, wraps the muzzle, floats near a fin, or hangs from the underside of the jaw without wrapping the neck. A knot, fringes, or the right color alone cannot establish placement.';
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.#prediction(model, input, token);
      const answer = Array.isArray(result) ? result.join('') : String(result);
      try {
        const verdict = JSON.parse(answer.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, ''));
        if (mentionsScarf && verdict?.scarf_attachment === 'misplaced' && Array.isArray(verdict.fixes)) {
          verdict.pass = false;
          verdict.fixes.push('Remove the misplaced cloth. Redraw one continuous scarf loop between the head and torso, with a band visible across the neck and both ends attached to it.');
        }
        const attachmentChecked = !mentionsScarf || ['neck_wrap','misplaced','other_request'].includes(verdict?.scarf_attachment);
        const colorChecked = !mentionsScarf || verdict?.contour_color === null || /^#[a-f\d]{6}$/i.test(verdict?.contour_color);
        if (attachmentChecked && colorChecked && Array.isArray(verdict?.fixes) && verdict.pass === (verdict.fixes.length === 0) &&
            verdict.fixes.every(fix => typeof fix === 'string' && fix.trim())) return verdict;
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
      input.system_instruction += ' The previous reply had invalid JSON or inconsistent fields. Check the schema before replying.';
    }
    const err = new Error('画面核验服务连续两次返回无效结果');
    err.qualityRejected = true;
    throw err;
  }

  async #prediction(model, input, token) {
    const created = await createPrediction(model, input, token);

    const deadline = Date.now() + (this.cfg.timeoutMs || 180000);
    let pred = created;
    while (!['succeeded','failed','canceled'].includes(pred.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      pred = await readReplicate(`https://api.replicate.com/v1/predictions/${created.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }, res => res.json());
    }
    if (pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`出图失败：${(pred.error || pred.status).toString().slice(0, 160)}`);
    }
    if (pred.status !== 'succeeded') throw new Error('出图超时');

    return pred.output;
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
