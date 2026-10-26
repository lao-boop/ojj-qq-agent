import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findPython } from './tts.js';
import { DATA_DIR } from './config.js';

const execFileAsync = promisify(execFile);

const DEFAULT_FFMPEG =
  process.env.FFMPEG_PATH ||
  path.join(process.env.LOCALAPPDATA || '', 'AstrBot', 'backend', 'python', 'ffmpeg.exe');

function ffmpegPath(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  if (DEFAULT_FFMPEG && fs.existsSync(DEFAULT_FFMPEG)) return DEFAULT_FFMPEG;
  return 'ffmpeg';
}

/** 从指定时间点开始截一段（用来“从某句歌词开始唱”）。 */
export async function cutAudioFrom(input, startSeconds, durationSeconds, { ffmpeg, tag = 'cut' } = {}) {
  const dir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${tag}-${Date.now()}.mp3`);
  const bin = ffmpegPath(ffmpeg);
  const args = ['-y', '-loglevel', 'error'];
  if (startSeconds > 0) args.push('-ss', String(Math.max(0, startSeconds - 0.3)));
  args.push('-i', input);
  if (durationSeconds > 0) args.push('-t', String(durationSeconds));
  args.push('-ac', '1', '-ar', '44100', '-b:a', '128k', out);
  try {
    await execFileAsync(bin, args, { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`截取失败：${String(err.stderr || err.message).slice(0, 120)}`);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 2000) throw new Error('截取失败：没有产出音频');
  return out;
}

/** 读取音频真实时长（ffmpeg 探测，失败则按码率估算）。 */
export async function probeDuration(filePath, { ffmpeg } = {}) {
  const bin = ffmpegPath(ffmpeg);
  try {
    const { stderr } = await execFileAsync(bin, ['-hide_banner', '-i', filePath], {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }).catch((err) => ({ stderr: String(err.stderr || '') }));
    const m = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    /* 忽略，走估算 */
  }
  try {
    const size = fs.statSync(filePath).size;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp3') return (size * 8) / 128000;
    if (ext === '.wav') return size / (16000 * 2);
  } catch {
    /* ignore */
  }
  return 0;
}

/** 截取音频前 N 秒（长歌翻唱前先砍短，控制耗时和费用）。 */
export async function trimAudio(input, seconds, { ffmpeg, tag = 'trim' } = {}) {
  const dir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${tag}-${Date.now()}.mp3`);
  const bin = ffmpegPath(ffmpeg);
  try {
    await execFileAsync(
      bin,
      ['-y', '-loglevel', 'error', '-i', input, '-t', String(seconds), '-ac', '1', '-ar', '44100', '-b:a', '128k', out],
      { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(`裁剪音频失败：${String(err.stderr || err.message).slice(0, 120)}`);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 2000) throw new Error('裁剪音频失败');
  return out;
}

export function ffmpegBin(configured) {
  return ffmpegPath(configured);
}

/** QQ 语音是 SILK，ffmpeg 解不了，用 pilk 转成 wav。 */
export async function silkToWav(input, { python, tag = 'silk' } = {}) {
  const dir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.statSync(input);
  const key = crypto.createHash('sha1').update(`${input}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 12);
  const out = path.join(dir, `${tag}-${key}.wav`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  const bin = findPython(python || process.env.PYTHON_PATH);
  const script = fileURLToPath(new URL('../scripts/silk_to_wav.py', import.meta.url));
  try {
    await execFileAsync(bin, [script, input, out, '24000'], { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`SILK 转码失败：${String(err.stderr || err.message).trim().slice(-1800)}`);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error('SILK 转码失败：没有产出');
  return out;
}

/** 把任意音频（含 QQ 语音）转成 16k 单声道 mp3，喂给 ASR 用。 */
export async function toMp3(input, { ffmpeg, tag = 'asr' } = {}) {
  const dir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.statSync(input);
  const key = crypto.createHash('sha1').update(`${input}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 12);
  const out = path.join(dir, `${tag}-${key}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  const bin = ffmpegPath(ffmpeg);
  try {
    await execFileAsync(
      bin,
      ['-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', out],
      { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(`音频转码失败：${String(err.stderr || err.message).slice(0, 120)}`);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 1000) throw new Error('音频转码失败：没有产出');
  return out;
}

/** 从视频里抽一帧代表画面（给视觉模型看）。 */
export async function extractFrame(videoPath, { ffmpeg, tag = 'frame' } = {}) {
  const dir = path.join(DATA_DIR, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${tag}-${Date.now()}.jpg`);
  const bin = ffmpegPath(ffmpeg);
  try {
    await execFileAsync(
      bin,
      ['-y', '-loglevel', 'error', '-t', '30', '-i', videoPath, '-vf', 'thumbnail=100', '-frames:v', '1', '-q:v', '3', out],
      { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(`抽帧失败：${String(err.stderr || err.message).slice(0, 120)}`);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 300) throw new Error('抽帧失败：没有产出画面');
  return out;
}

/** 从视频里抽出音轨（单声道 mp3），给变声用。 */
export async function extractAudio(videoPath, { ffmpeg, tag = 'video' } = {}) {
  const dir = path.join(DATA_DIR, 'audio');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${tag}-${Date.now()}.mp3`);
  const bin = ffmpegPath(ffmpeg);
  try {
    await execFileAsync(
      bin,
      ['-y', '-loglevel', 'error', '-i', videoPath, '-vn', '-map', '0:a:0?', '-ac', '1', '-ar', '44100', '-b:a', '128k', out],
      { timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(`抽音轨失败：${String(err.stderr || err.message).slice(0, 160)}`);
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 2000) throw new Error('视频里没有可用的音轨');
  return out;
}
