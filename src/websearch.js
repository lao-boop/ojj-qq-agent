const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

function decodeEntities(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBing(html) {
  const out = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  for (const b of blocks) {
    const title = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const snippet = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const link = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/);
    const t = decodeEntities(title?.[1] || '');
    const s = decodeEntities(snippet?.[1] || '');
    if (t) out.push({ title: t, snippet: s, url: link?.[1] || '' });
  }
  return out;
}

function parseBaidu(html) {
  const out = [];
  const blocks = html.match(/<div[^>]+class="result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g) || [];
  for (const b of blocks) {
    const title = b.match(/<h3[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const snippet = b.match(/<span[^>]*class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/) || b.match(/<div[^>]*class="c-abstract"[^>]*>([\s\S]*?)<\/div>/);
    const t = decodeEntities(title?.[1] || '');
    const s = decodeEntities(snippet?.[1] || '');
    if (t) out.push({ title: t, snippet: s, url: '' });
  }
  return out;
}

async function fetchHtml(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 联网搜索（Bing 中文，失败退回百度），返回 [{title, snippet, url}] */
export async function webSearch(query, { limit = 5, timeoutMs = 15000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items.slice(0, limit);

  let items = [];
  try {
    const html = await fetchHtml(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=10`, timeoutMs);
    items = parseBing(html);
  } catch {
    /* 换百度 */
  }
  if (!items.length) {
    try {
      const html = await fetchHtml(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&ie=utf-8`, timeoutMs);
      items = parseBaidu(html);
    } catch {
      /* ignore */
    }
  }
  items = items.filter((i) => i.title).slice(0, 8);
  cache.set(key, { at: Date.now(), items });
  return items.slice(0, limit);
}

export async function publicPlaceSearch(query, options) {
  const key = 'place:' + query;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  let items = [];
  try {
    const html = await fetchHtml('https://www.so.com/s?q=' + encodeURIComponent(query), options.timeoutMs);
    for (const block of html.split(/<h3\b/i).slice(1)) {
      const end=block.indexOf('</h3>');
      if(end<0) continue;
      const heading='<h3'+block.slice(0,end+5);
      const url = heading.match(/\bdata-mdurl=["']([^"']+)["']/i)?.[1];
      const title = decodeEntities(heading);
      const snippet=decodeEntities(block.slice(end+5,end+4000).split(/<cite\b|<\/li>|<script\b/i)[0]).slice(0,350);
      if (url && title) items.push({title,url:decodeEntities(url),snippet});
    }
  } catch { /* fall back to the ordinary search provider */ }
  items.push(...await webSearch(query,options));
  cache.set(key,{at:Date.now(),items});
  return items;
}
