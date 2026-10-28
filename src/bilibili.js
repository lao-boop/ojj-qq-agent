import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './config.js';

const execFileAsync = promisify(execFile);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const VIDEO_DIR = path.join(DATA_DIR, 'videos');

let cookieCache = { value: '', at: 0 };

/** B 站接口需要 buvid cookie，否则搜索会被 412。 */
async function biliCookie(force = false) {
  if (!force && cookieCache.value && Date.now() - cookieCache.at < 10 * 60 * 1000) return cookieCache.value;
  const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  const b3 = data?.data?.b_3 || '';
  const b4 = data?.data?.b_4 || '';
  if (!b3) throw new Error('拿不到 B 站 cookie');
  cookieCache = { value: `buvid3=${b3}; buvid4=${b4}; b_nut=${Math.floor(Date.now() / 1000)}`, at: Date.now() };
  return cookieCache.value;
}

function parseDuration(text) {
  const parts = String(text || '')
    .split(':')
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (!parts.length) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

/** B 站搜索：返回带时长、播放量、封面的候选。 */
export async function searchBili(keyword, limit = 10) {
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=' +
    encodeURIComponent(keyword);
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = await biliCookie(attempt > 0).catch(() => '');
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status !== 412) break;
    cookieCache = { value: '', at: 0 };
  }
  if (!res.ok) throw new Error(`B站搜索 HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`B站搜索失败：${data.message || data.code}`);
  return (data.data?.result || [])
    .map((v) => ({
      bvid: String(v.bvid || ''),
      title: cleanTitle(v.title),
      seconds: parseDuration(v.duration),
      durationText: String(v.duration || ''),
      author: String(v.author || ''),
      play: Number(v.play || 0),
      cover: String(v.pic || '').replace(/^\/\//, 'https://'),
    }))
    .filter((v) => v.bvid && v.seconds > 0)
    .slice(0, limit);
}

/** 在候选里挑一个适合发送的：优先 20 秒~5 分钟、播放量高。 */
export function pickVideo(candidates, maxSeconds = 300) {
  const usable = candidates.filter((v) => v.seconds >= 10 && v.seconds <= maxSeconds);
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const score = (v) => Math.log10(v.play + 10) - Math.abs(v.seconds - 90) / 600;
    return score(b) - score(a);
  });
  return usable[0];
}

/** 用 yt-dlp 下载 B 站视频，返回本地 mp4。 */
export async function downloadBili(bvid, python, { maxHeight = 360, maxBytes = 15 * 1024 * 1024 } = {}) {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  const out = path.join(VIDEO_DIR, `${bvid}-${Date.now()}.mp4`);
  const target = `https://www.bilibili.com/video/${bvid}`;
  const formats = [`bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]/b`, `b[height<=${maxHeight}]/b`, 'b'];
  let lastErr;
  for (const fmt of formats) {
    try {
      await execFileAsync(
        python,
        [
          '-m',
          'yt_dlp',
          '--no-playlist',
          '--no-warnings',
          '--socket-timeout',
          '20',
          '--retries',
          '2',
          '-f',
          fmt,
          '--merge-output-format',
          'mp4',
          '-o',
          out,
          target,
        ],
        { timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      if (fs.existsSync(out) && fs.statSync(out).size > 20000) {
        const size = fs.statSync(out).size;
        if (size > maxBytes) throw new Error(`视频太大（${Math.round(size / 1024 / 1024)}MB）`);
        return { file: out, size };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`下载失败：${String(lastErr?.stderr || lastErr?.message || '').slice(0, 200)}`);
}

export function videoFileName(title) {
  return (
    String(title || 'bilibili')
      .replace(/[\\/:*?"<>|]/g, '')
      .slice(0, 40) + '.mp4'
  );
}
