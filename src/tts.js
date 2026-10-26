import { synthesizeMiniMax } from './minimax-tts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.js';

const execFileAsync = promisify(execFile);

/** 常用中文音色，配置里可以写别名，也可以直接写完整名字。 */
export const VOICE_ALIASES = {
  晓伊: 'zh-CN-XiaoyiNeural',
  晓晓: 'zh-CN-XiaoxiaoNeural',
  晓辰: 'zh-CN-XiaochenNeural',
  晓涵: 'zh-CN-XiaohanNeural',
  云希: 'zh-CN-YunxiNeural',
  云健: 'zh-CN-YunjianNeural',
  云扬: 'zh-CN-YunyangNeural',
  晓梦: 'zh-CN-XiaomengNeural',
};

function resolveVoice(voice) {
  const raw = String(voice || '').trim();
  if (!raw) return 'zh-CN-XiaoyiNeural';
  return VOICE_ALIASES[raw] || raw;
}

export function findPython(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'AstrBot', 'backend', 'python', 'python.exe'),
    ...(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']),
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (c === 'python' || c === 'python3') return c;
    if (fs.existsSync(c)) return c;
  }
  return 'python';
}

/**
 * Edge TTS：调用本机 Python 的 edge-tts 包合成 mp3。
 * 用官方包而不是自己拼 WebSocket，省得跟着微软改 DRM 签名。
 */
export class TTS {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.dir = path.join(DATA_DIR, 'audio');
    fs.mkdirSync(this.dir, { recursive: true });
    this.python = findPython(cfg.pythonPath);
    this.voice = cfg.provider === 'minimax' ? cfg.minimax?.voiceId || '' : resolveVoice(cfg.voice);
  }

  updateConfig(cfg) {
    this.cfg = cfg;
    this.python = findPython(cfg.pythonPath);
    this.voice = cfg.provider === 'minimax' ? cfg.minimax?.voiceId || '' : resolveVoice(cfg.voice);
  }

  async checkAvailable() {
    if (this.cfg.provider === 'minimax') return this.cfg.minimax?.apiKey && this.voice ? 'minimax-configured' : '';
    try {
      const { stdout } = await execFileAsync(this.python, ['-c', 'import edge_tts; print(edge_tts.__version__)'], {
        timeout: 15000,
        windowsHide: true,
      });
      return String(stdout).trim();
    } catch (err) {
      this.logger.warn(`TTS 依赖检查失败：${err.message}`);
      return '';
    }
  }

  /** 合成一段语音，返回 { file, name, bytes, ms }。 */
  async synthesize(text) {
    if (!this.cfg.enabled) throw new Error('语音功能已关闭');
    const clean = String(text || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/[#*`>]/g, '')
      .trim();
    if (!clean) throw new Error('空文本');
    if (clean.length > (this.cfg.maxChars || 120)) throw new Error(`语音文本超过 ${this.cfg.maxChars || 120} 字，请分段发送；未截断或调用语音服务`);

    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    const file = path.join(this.dir, name);
    const started = Date.now();
    if (this.cfg.provider === 'minimax') {
      const bytes = await synthesizeMiniMax(clean, this.cfg.minimax || {});
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      return { file, name, bytes: bytes.length, ms: Date.now() - started, text: clean, voice: this.voice };
    }
    if (this.cfg.provider && this.cfg.provider !== 'edge') throw new Error('未知的语音输出服务');
    const args = [
      '-m',
      'edge_tts',
      '--voice',
      this.voice,
      '--text',
      clean,
      '--rate',
      this.cfg.rate || '+0%',
      '--pitch',
      this.cfg.pitch || '+0Hz',
      '--write-media',
      file,
    ];

    try {
      await execFileAsync(this.python, args, {
        timeout: this.cfg.timeoutMs || 30000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      const detail = (err.stderr || err.message || '').toString().slice(0, 300);
      throw new Error(`语音合成失败：${detail}`);
    }

    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) throw new Error('语音合成没有产出音频');
    const bytes = fs.statSync(file).size;
    this.logger.info(`语音合成完成 ${Math.round(bytes / 1024)}KB ${Date.now() - started}ms（${this.voice}）`);
    return { file, name, bytes, ms: Date.now() - started, text: clean, voice: this.voice };
  }
}

/** 给控制台用的试听：合成后返回 base64。 */
export async function ttsPreview(tts, text) {
  const r = await tts.synthesize(text);
  const buf = fs.readFileSync(r.file);
  return { ...r, base64: buf.toString('base64'), dir: ROOT };
}
