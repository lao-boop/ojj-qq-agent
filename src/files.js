import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, ROOT } from './config.js';
import { findPython } from './tts.js';

const execFileAsync = promisify(execFile);
const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_BYTES = 100 * 1024 * 1024; // QQ 文件常见 20~50MB，别卡在 20MB
const DOWNLOAD_TIMEOUT_MS = 120000;

export function asksAboutFile(text) {
  return /总结|概括|解析|看看|看一下|内容|讲了什么|读一下|提取|要点|分析|翻译|原文|补全|单元格|工作表|图片|图中|图里|逐页|每一?页|每一?张幻灯片|第\s*\d+\s*[页段]|\b[A-Z]{1,3}\d+\b/i.test(text || '');
}

function safeName(name) {
  const base = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(-80);
  return base || 'file';
}

/**
 * QQ 文件消息处理：把文件下载到 data/files，再用 Python 抽文字。
 * 支持 docx / pptx / xlsx / pdf / txt / md / csv / json / xml。
 */
export class FileReader {
  constructor({ cfg, logger }) {
    this.cfg = cfg || {};
    this.logger = logger;
    fs.mkdirSync(FILES_DIR, { recursive: true });
    this.python = findPython(this.cfg.pythonPath);
  }

  updateConfig(cfg) {
    this.cfg = cfg || {};
    this.python = findPython(this.cfg.pythonPath);
  }

  /** seg.data: { file, file_id, name, size, url }（OneBot 各种实现字段不完全一样） */
  async download(onebot, data = {}) {
    const name = safeName(data.name || data.file || 'file');
    const target = path.join(FILES_DIR, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${name}`);

    const url = data.url || (/^https?:\/\//i.test(data.file || '') ? data.file : '');
    if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`下载文件失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error(`文件太大（${Math.round(buf.length / 1024 / 1024)}MB，上限 100MB）`);
      fs.writeFileSync(target, buf);
      this.logger?.info?.(`文件已下载：${name}（${Math.round(buf.length / 1024 / 1024)}MB）`);
      return { path: target, name, size: buf.length };
    }

    let local = String(data.file || '');
    if (local.startsWith('file://')) {
      try {
        local = fileURLToPath(local);
      } catch {
        local = local.replace(/^file:\/\/\/?/, '');
      }
    }
    if (local && fs.existsSync(local)) {
      const size = fs.statSync(local).size;
      if (size > MAX_BYTES) throw new Error(`文件太大（${Math.round(size / 1024 / 1024)}MB，上限 100MB）`);
      fs.copyFileSync(local, target);
      return { path: target, name, size };
    }

    const fileId = data.file_id || data.file;
    if (fileId && onebot) {
      const info = await onebot.call('get_file', { file_id: fileId, file: fileId }, 60000);
      const got = info?.file || info?.url;
      if (got && /^https?:\/\//i.test(got)) {
        return this.download(onebot, { ...data, url: got, file: '' });
      }
      if (got && fs.existsSync(got)) {
        const size = fs.statSync(got).size;
        if (size > MAX_BYTES) throw new Error(`文件太大（${Math.round(size / 1024 / 1024)}MB，上限 100MB）`);
        fs.copyFileSync(got, target);
        return { path: target, name, size };
      }
    }
    throw new Error('拿不到文件内容（OneBot 没给链接，get_file 也失败）');
  }

  async extractText(file, question = '') {
    const script = path.join(ROOT, 'scripts', 'extract_text.py');
    try {
      const { stdout } = await execFileAsync(this.python, [script, file.path, String(question).slice(0, 4000)], {
        timeout: 60000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      const json = JSON.parse(String(stdout).trim().split('\n').pop());
      return json;
    } catch (err) {
      return { ok: false, error: String(err.stderr || err.message).slice(0, 200) };
    }
  }

  async read(onebot, data, question = '') {
    const file = await this.download(onebot, data);
    const result = await this.extractText(file, question);
    this.logger.info(
      `文件 ${file.name}（${Math.round(file.size / 1024)}KB）解析${result.ok ? `出 ${result.chars} 字` : `失败：${result.error}`}`,
    );
    return { ...file, ...result };
  }

  /** 抽出 Office 文件里内嵌的图片（docx/pptx/xlsx）。 */
  async documentImages(file, question) {
    const ordinal = /第\s*([1-9]\d*|[一二三四五六七八九十])\s*张(?:图|照片)/.exec(question || '')?.[1];
    const index = Number(ordinal) || ('一二三四五六七八九十'.indexOf(ordinal) + 1);
    return this.extractImages(file, index ? 1 : 3, question, index, true);
  }

  async extractImages(file, limit = 3, question = '', index = 0, includeContext = false) {
    if (!/\.(docx|pptx|xlsx)$/i.test(file.name || file.path || '')) return [];
    const outDir = path.join(FILES_DIR, 'media');
    const script = path.join(ROOT, 'scripts', 'extract_media.py');
    try {
      const page = /第\s*(\d+)\s*(?:页|[张張]幻灯片)/.exec(question)?.[1] || '0';
      const { stdout } = await execFileAsync(this.python, [script, file.path, outDir, page, String(index)], {
        timeout: 60000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const json = JSON.parse(String(stdout).trim().split('\n').pop() || '{}');
      const paths = (json.images || []).slice(0, limit);
      if (!includeContext) return paths;
      // The reader already resolved these positions. They are not objects inside the image.
      const visualQuestion = String(question || '')
        .replace(/第\s*[\d一二三四五六七八九十]+\s*(?:页|[张張]幻灯片)(?:的)?/g, '')
        .replace(/第\s*[\d一二三四五六七八九十]+\s*张(?:图片?|照片)/g, '这张图')
        .slice(0, 500);
      return paths.map(file => ({file, preview:json.previews?.[file], documentImage:true, question:visualQuestion, context:json.contexts?.[file]}));
    } catch (err) {
      this.logger.warn(`抽取文件图片失败：${String(err.stderr || err.message).slice(0, 120)}`);
      return [];
    }
  }
}
