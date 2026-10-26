import fs from 'node:fs';
import path from 'node:path';

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg', '.wma']);

/** 把文件名拆成 歌手 / 歌名："00000周深-小美满.mp3" → {artist:'周深', title:'小美满'} */
export function parseTrackName(filename) {
  let base = path.basename(filename).replace(/\.[^.]+$/, '');
  base = base.replace(/\s*[-－—]\s*副本\s*$/, '').trim();
  base = base.replace(/^[\d\s_.\-]+/, '');
  const m = base.match(/^(.{1,40}?)\s*[-－—]\s*(.+)$/);
  let artist = '';
  let title = base;
  if (m) {
    artist = m[1].trim();
    title = m[2].trim();
  }
  artist = artist.replace(/_/g, ' / ');
  title = title.replace(/\s+/g, ' ').trim();
  return { artist, title };
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s_\-－—·.。,，!！?？'"“”‘’《》<>【】\[\]]/g, '');
}

/**
 * 本地曲库：扫描音乐目录，按歌名/歌手做模糊匹配，用来“点歌名自动翻唱”。
 */
export class MusicLibrary {
  constructor(cfg, logger) {
    this.cfg = cfg || {};
    this.logger = logger;
    this.tracks = [];
    this.lastScan = 0;
  }

  updateConfig(cfg) {
    this.cfg = cfg || {};
    this.tracks = [];
    this.lastScan = 0;
  }

  get enabled() {
    return Boolean(this.cfg?.enabled && this.cfg?.dir);
  }

  scan() {
    if (!this.enabled) return 0;
    const root = this.cfg.dir;
    if (!fs.existsSync(root)) {
      this.logger.warn(`曲库目录不存在：${root}`);
      return 0;
    }
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
          const { artist, title } = parseTrackName(e.name);
          out.push({
            path: full,
            title,
            artist,
            normTitle: normalize(title),
            normArtist: normalize(artist),
            normFile: normalize(e.name),
          });
        }
      }
    };
    walk(root, 0);
    this.tracks = out;
    this.lastScan = Date.now();
    this.logger.info(`曲库扫描完成：${out.length} 首（${root}）`);
    return out.length;
  }

  ensureScanned() {
    if (!this.tracks.length && Date.now() - this.lastScan > 5000) this.scan();
  }

  /** 模糊搜索，返回按匹配度排序的候选。 */
  search(query, { limit = 5, artist = '', excludeTitle = '' } = {}) {
    this.ensureScanned();
    const q = normalize(query).replace(/[吗呢吧啊呀呗嘛哦喔]+$/, '');
    if (!q) return [];
    const a = normalize(artist);
    const ex = normalize(excludeTitle);
    const scored = [];
    for (const t of this.tracks) {
      if (ex && (t.normTitle === ex || t.normFile.includes(ex))) continue;
      let score = 0;
      if (t.normTitle === q) score = 100;
      else if (t.normArtist === q) score = 96; // 有些文件是「歌名-歌手」，名字落在 artist 字段
      else if (t.normTitle.includes(q)) score = 80 + Math.min(10, (q.length / t.normTitle.length) * 10);
      else if (q.includes(t.normTitle) && t.normTitle.length >= 2) score = 70;
      else if (t.normArtist.includes(q)) score = 72;
      else if (t.normFile.includes(q)) score = 55;
      if (score <= 0) continue;
      if (a) {
        const artistHit =
          t.normArtist.includes(a) || t.normTitle.includes(a) || t.normFile.includes(a);
        score += artistHit ? 15 : -20;
      }
      if (score > 0) scored.push({ ...t, score });
    }
    return scored.sort((a2, b2) => b2.score - a2.score).slice(0, limit);
  }
}

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnToNumber(text) {
  const s = String(text);
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s === '半') return 0.5;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return (a ? CN_DIGITS[a] ?? 0 : 1) * 10 + (b ? CN_DIGITS[b] ?? 0 : 0);
  }
  if (s.length === 1 && s in CN_DIGITS) return CN_DIGITS[s];
  return NaN;
}

/**
 * 从话里解析“要多久”：“只要50秒”“来两分钟”“唱一分半”。
 * 返回秒数；没提到就返回 0。
 */
export function parseDuration(text) {
  const t = String(text || '');
  let seconds = 0;

  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:秒钟?|sec(?:onds?)?|s(?![a-z]))/i);
  if (m) seconds = Number(m[1]);
  if (!seconds) {
    m = t.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min(?:utes?)?|m(?![a-z]))/i);
    if (m) seconds = Number(m[1]) * 60;
  }
  if (!seconds) {
    m = t.match(/([零一二两三四五六七八九十半]{1,3})\s*(?:秒钟?|秒)/);
    if (m) seconds = cnToNumber(m[1]);
  }
  if (!seconds) {
    m = t.match(/([零一二两三四五六七八九十半]{1,3})\s*(?:分钟|分)/);
    if (m) seconds = cnToNumber(m[1]) * 60;
  }
  if (/一分半/.test(t) && seconds <= 60) seconds = 90;
  if (!seconds && /半小时/.test(t)) seconds = 1800;
  if (!seconds) return 0;
  return Math.min(Math.max(Math.round(seconds), 5), 300);
}

/** 从“从「不懂怎么描写温柔的我们」开始唱”里抽出起始歌词。 */
export function extractStartPhrase(text) {
  const t = String(text || '');
  const m = t.match(
    /从\s*[“"'「『《]?\s*([^”"'」』》，。！？\n]{2,40}?)\s*[”"'」』》]?\s*(?:开始|唱起|开始唱|那句|那一句|这一句)/,
  );
  return m ? m[1].trim() : '';
}

/** 从“翻唱 心似烟火”里抽取歌名。 */
export function extractSongQuery(text) {
  const raw = String(text || '').trim();
  const m = raw.match(
    /(?:翻唱|点歌|点一首|点首|想听(?!听)|来一首|唱一下|唱|cover)\s*[《【「"']?([^》】」"'，。！？\n]{1,40})[》】」"'，。！？]?/i,
  );
  if (!m) return '';
  let q = m[1].trim();
  q = q.split(/\s*从\s*/)[0].trim();
  q = q.replace(/^(帮我|给我|我想听|想听|我要听|能|可以|请|麻烦)\s*/, '').trim();
  q = q.replace(/[吗呢吧啊呀呗嘛哦喔]+$/, '').trim();
  q = q.replace(/^(一首|一下|个|首)\s*/, '').trim();
  // “听听是不是…”“听一下”“唱得怎么样”这类是评价/聊天，不是点歌
  if (/^(是不是|是否|一下|起来|着|完|得|说)/.test(q)) return '';
  if (!q || /^(一下|这个|那个|吧|呀|啊|给我)$/.test(q)) return '';
  // “唱首歌”“唱一段”这类不是点歌
  if (/^(歌|首歌|首|一段|段|一点|什么|哪首|这首|那首)/.test(q)) return '';
  return q;
}

/** 把「是林俊杰的江南，从…开始唱」拆成 歌手 / 歌名 / 起始句。 */
export function parseCoverRequest(text) {
  const t = String(text || '').trim();
  const startPhrase = extractStartPhrase(t);
  let title = extractSongQuery(t);
  let artist = '';

  // “是林俊杰的江南”“就是周深的《小美满》”
  const m = t.match(
    /(?:是|就是|要听|想听|听)\s*([\u4e00-\u9fa5A-Za-z·]{2,12})\s*的\s*《?([^》，,。！？\s]{1,20})》?/,
  );
  if (m) {
    artist = m[1].trim();
    title = m[2].trim();
  }

  // 只有真的像点歌/翻唱才放行；普通聊天（“发条语音给我呗”）一律不算
  const explicitSong = Boolean(extractSongQuery(t));
  const coverIntent =
    Boolean(title) && (explicitSong || Boolean(m)) ||
    Boolean(startPhrase) ||
    (/翻唱|点歌|点一首|点首|想听|来一首|唱一段|开始唱/.test(t) && Boolean(title));
  return { title: title.trim(), artist, startPhrase, coverIntent };
}

/** 是不是在纠正“不是这首”。 */
export function isCorrection(text) {
  return /不是这(一)?首|不是这个|不是他|不是她|不对|错了|换一首|换一个|重新找/.test(String(text || ''));
}

/** Execution boundary: artist-only matches never authorize a particular song. */
export function resolveCoverTrack(library, slots, exclude = []) {
  if (!library.enabled) return { reply: '本地曲库未启用，暂时无法核验并翻唱这首歌。' };
  library.ensureScanned();
  const title = normalize(slots.title), artist = normalize(slots.artist);
  const hits = library.tracks.filter(t => normalize(t.title) === title &&
    (!artist || normalize(t.artist) === artist) && !exclude.some(x => normalize(x) === normalize(t.title)));
  if (!hits.length) return { reply: `没有找到${slots.artist ? slots.artist + '的' : ''}《${slots.title}》的准确匹配；不会用同歌手的其他歌曲替代。` };
  if (hits.length !== 1) return { reply: `《${slots.title}》有多个版本，请补充歌手或版本信息，暂时不会自动选择。` };
  return { value: hits[0] };
}
