import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const QUEUE_FILE = path.join(DATA_DIR, 'wecom-relay-queue.json');

const CN_DIGITS = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export function cnToInt(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a ? CN_DIGITS[a] : 1;
    const ones = b ? CN_DIGITS[b] : 0;
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }
  return CN_DIGITS[s] ?? NaN;
}

function atTime(base, hour, minute) {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function weekdayIndex(ch) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  return map[ch] || 0;
}

function removeOnce(text, part) {
  if (!part) return text;
  const idx = text.indexOf(part);
  if (idx < 0) return text;
  return (text.slice(0, idx) + text.slice(idx + part.length)).trim();
}

/**
 * 解析中文时间。
 * 返回 { at, dateText, timeText, matched }；解析不到返回 null。
 */
export function parseWhen(text, now = new Date()) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // ISO：2026-11-21 15:00
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})[:：](\d{1,2})?/.exec(raw);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4]), Number(iso[5] || 0), 0, 0);
    return { at: d.getTime(), dateText: iso[0], timeText: '', matched: iso[0] };
  }

  // 相对：半小时后 / 10分钟后 / 两小时后
  const rel = /(半|[\d一二两三四五六七八九十]+)\s*(分钟|小时|天)\s*后/.exec(raw);
  if (rel) {
    const n = rel[1] === '半' ? 0.5 : cnToInt(rel[1]);
    const unit = rel[2];
    const ms = unit === '天' ? n * 86400000 : unit === '小时' ? n * 3600000 : n * 60000;
    return { at: now.getTime() + ms, dateText: '', timeText: rel[0], matched: rel[0] };
  }

  // 日期部分
  let date = null;
  let dateText = '';
  let dateKind = '';
  let m;

  m = /(今天|今日)/.exec(raw);
  if (m) {
    date = new Date(now);
    dateText = m[0];
    dateKind = 'today';
  }
  if (!date) {
    m = /(明天|明日)/.exec(raw);
    if (m) {
      date = new Date(now);
      date.setDate(date.getDate() + 1);
      dateText = m[0];
      dateKind = 'tomorrow';
    }
  }
  if (!date) {
    m = /(后天)/.exec(raw);
    if (m) {
      date = new Date(now);
      date.setDate(date.getDate() + 2);
      dateText = m[0];
      dateKind = 'after';
    }
  }
  if (!date) {
    m = /(大后天)/.exec(raw);
    if (m) {
      date = new Date(now);
      date.setDate(date.getDate() + 3);
      dateText = m[0];
      dateKind = 'after';
    }
  }
  if (!date) {
    m = /(下周|下星期|下礼拜|周|星期|礼拜)([一二三四五六日天])/.exec(raw);
    if (m) {
      const target = weekdayIndex(m[2]);
      const d = new Date(now);
      let diff = (target - d.getDay() + 7) % 7;
      if (m[1].startsWith('下') && diff === 0) diff = 7;
      d.setDate(d.getDate() + diff);
      date = d;
      dateText = m[0].replace(/\s+/g, '');
      dateKind = 'weekday';
    }
  }
  if (!date) {
    m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(raw);
    if (m) {
      const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), 9, 0, 0, 0);
      date = d;
      dateText = m[0];
      dateKind = 'monthday';
    }
  }

  // 时间部分：先把日期文字去掉，避免“周五10点”把“五”当成小时
  let timeSource = raw;
  if (dateText) timeSource = removeOnce(timeSource, dateText);
  let time = null;
  let timeText = '';
  let tm = /(上午|下午|晚上|中午|凌晨|早上)?\s*([零一二三四五六七八九十两\d]{1,3})\s*(?:点|时|[:：])\s*(半|[零一二三四五六七八九十两\d]{1,3})?\s*分?/.exec(timeSource);
  if (tm) {
    let hour = cnToInt(tm[2]);
    let minute = tm[3] === '半' ? 30 : tm[3] ? cnToInt(tm[3]) : 0;
    const period = tm[1] || '';
    if (Number.isFinite(hour)) {
      if (period === '下午' || period === '晚上') {
        if (hour < 12) hour += 12;
      } else if (period === '中午') {
        if (hour < 11) hour += 12;
      } else if (period === '凌晨') {
        if (hour === 12) hour = 0;
      }
      if (hour === 24) hour = 0;
      time = { hour, minute: Number.isFinite(minute) ? minute : 0 };
      timeText = tm[0].trim();
    }
  }

  if (!date && !time) return null;

  const d = date ? new Date(date) : new Date(now);
  if (time) {
    d.setHours(time.hour, time.minute, 0, 0);
  } else {
    d.setHours(9, 0, 0, 0);
  }

  // 周几：过了就顺延到下周
  if (dateKind === 'weekday' && d.getTime() <= now.getTime()) {
    d.setDate(d.getDate() + 7);
  }
  // 几月几号：过了就顺延到明年
  if (dateKind === 'monthday' && d.getTime() <= now.getTime()) {
    d.setFullYear(d.getFullYear() + 1);
  }
  // 只有时间、没日期：过了就顺延到明天
  if (!date && time && d.getTime() <= now.getTime()) {
    d.setDate(d.getDate() + 1);
  }

  return {
    at: d.getTime(),
    dateText,
    timeText,
    matched: [dateText, timeText].filter(Boolean).join(' '),
  };
}

/**
 * 从一句话里解析收件人。
 * known：已知名字数组（含“老板/爵士/示例联系人”等别名）。
 */
export function parseTargets(text, known = []) {
  let rest = String(text || '').replace(/^[\s，,：:、]+/, '').trim();
  const names = [];
  const namesLower = [...new Set(known.filter(Boolean))];

  // 优先用已知名字做最长匹配，支持“张三和李四交周报”
  while (rest) {
    const hit = namesLower
      .filter((n) => rest.startsWith(n))
      .sort((a, b) => b.length - a.length)[0];
    if (!hit) break;
    names.push(hit);
    rest = rest.slice(hit.length).replace(/^\s+/, '');
    const conn = /^(和|与|及|跟|、|,|，)\s*/.exec(rest);
    if (conn && namesLower.some((n) => rest.slice(conn[0].length).startsWith(n))) {
      rest = rest.slice(conn[0].length);
      continue;
    }
    break;
  }

  // 没有已知名字时，按连接词粗切，交给上层报“不认识”
  if (!names.length) {
    const head = rest.split(/[，,。.!?！？；;]/)[0];
    const parts = head.split(/[和与及、]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) {
      names.push(...parts.slice(0, 5));
      rest = rest.slice(head.length);
    }
  }

  return { names: [...new Set(names)].slice(0, 10), rest: rest.trim() };
}

const VERBS = '提醒|通知|告诉|转告|转发给|发给|转给|传给|跟|和';

/** 去掉“说一下 / 说一声 / 帮我 / 一下，”这类口头前缀。 */
export function cleanRelayContent(rest) {
  let s = String(rest || '').trim();
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^[\s，,：:、]+/, '')
      .replace(
        /^(?:说\s*一下|说\s*一声|说\s*一句|讲\s*一下|讲\s*一声|讲\s*一句|说一下|说一声|说一句|讲一下|讲一声|讲一句|告诉我|告诉|通知|转告|传达|带句话|带个话)\s*[，,：:、]?\s*/,
        '',
      )
      .replace(/^说\s*[，,：:、]\s*/, '')
      .replace(/^(?:一下|一声|一句)\s*[，,：:、]?\s*/, '')
      .replace(/^(?:帮我|帮忙|替我|请)\s*[，,：:、]?\s*/, '');
  } while (s !== prev);
  return s.replace(/[。.!！?？\s]+$/, '').trim();
}

/**
 * 解析传话指令。
 * 返回 { action, names, content, when, isSchedule, raw } 或 null
 */
export function parseRelayCommand(text, { isBoss = false, known = [], now = new Date() } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  if (/(取消|撤销|删掉).{0,6}(定时|提醒|安排|待发)/.test(raw)) {
    return { action: 'cancel', names: [], content: '', when: null, isSchedule: true, raw };
  }
  if (/(有哪些|查看|列出|看看).{0,6}(待发|定时|提醒|安排)/.test(raw)) {
    return { action: 'list', names: [], content: '', when: null, isSchedule: true, raw };
  }

  const vm = new RegExp(`(${VERBS})`).exec(raw);
  if (!vm) return null;

  // 去掉“帮我/请/麻烦”前缀
  const afterVerb = raw.slice(vm.index + vm[1].length).trim();
  const when = parseWhen(raw, now);

  const timeIndex = when
    ? Math.min(
        ...[when.dateText, when.timeText]
          .filter(Boolean)
          .map((s) => raw.indexOf(s))
          .filter((i) => i >= 0),
      )
    : -1;
  const timeBeforeVerb = Number.isFinite(timeIndex) && timeIndex >= 0 && timeIndex < vm.index;
  const hasClock = Boolean(when?.timeText) && !/^(半|[\d一二两三四五六七八九十]+)\s*(分钟|小时|天)后$/.test(when.timeText);
  const scheduleVerb = /提醒|通知|安排/.test(vm[1]);
  const shouldSchedule = Boolean(when) && (timeBeforeVerb || scheduleVerb) && when.at > now.getTime() + 60000;

  // 只有确认是“定时”时才把时间短语从正文里删掉
  let work = raw;
  if (shouldSchedule && when) {
    if (when.dateText) work = removeOnce(work, when.dateText);
    if (when.timeText) work = removeOnce(work, when.timeText);
    if (when.matched && work.includes(when.matched)) work = removeOnce(work, when.matched);
  }

  const vm2 = new RegExp(`(${VERBS})`).exec(work);
  if (!vm2) return null;
  let tail = work.slice(vm2.index + vm2[1].length).trim();
  tail = tail.replace(/^(一下|一声|一句|说|告诉|通知)\s*/, '');

  const parsed = parseTargets(tail, known);
  let names = parsed.names;
  let content = cleanRelayContent(parsed.rest);

  // 去掉附件指代，正文为空时由调用方挂最近媒体
  if (/^(这份|这个|刚才的?|那个|文件|图片|附件|材料)/.test(content)) {
    content = '';
  }

  return {
    action: 'send',
    names,
    content,
    when,
    isSchedule: shouldSchedule,
    raw,
  };
}

/** 解析“给X传话/带话/说一声”这类说法。 */
export function parseRelayToCommand(text, { now = new Date() } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const src = raw.replace(/^(?:帮我|帮忙|替我|请)\s*/, '');
  const m = /(?:给|替|向|帮)\s*([^\s，,。：:我你他她它]{1,20}?)\s*(?:传话|带话|带个话|带句话|捎句话|捎个话|说一声|说句话|说一下|带一句|发个消息|发条消息|发消息|发一条|发一句话|发句|发通知|发)/.exec(
    src,
  );
  if (!m) return null;

  const target = m[1].trim();
  if (!target || target.endsWith('组')) return null;
  const verbIndex = raw.indexOf(m[0]);

  const when = parseWhen(raw, now);
  const timeIndex = when
    ? Math.min(
        ...[when.dateText, when.timeText]
          .filter(Boolean)
          .map((s) => raw.indexOf(s))
          .filter((i) => i >= 0),
      )
    : -1;
  const timeBeforeVerb = Number.isFinite(timeIndex) && timeIndex >= 0 && timeIndex < verbIndex;
  const isSchedule = Boolean(when) && timeBeforeVerb && when.at > now.getTime() + 60000;

  let rest = raw.slice(verbIndex + m[0].length);
  if (isSchedule && when) {
    if (when.dateText) rest = removeOnce(rest, when.dateText);
    if (when.timeText) rest = removeOnce(rest, when.timeText);
  }

  return {
    action: 'send',
    names: [target],
    content: cleanRelayContent(rest),
    when,
    isSchedule,
    raw,
  };
}

/** 解析“给宣传组发个消息……”这类组指令。 */
export function parseGroupCommand(text, { groupNames = [], now = new Date() } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const hit = [...groupNames]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((n) => raw.includes(n));
  if (!hit) return null;

  const groupIndex = raw.indexOf(hit);
  const when = parseWhen(raw, now);
  const timeIndex = when
    ? Math.min(
        ...[when.dateText, when.timeText]
          .filter(Boolean)
          .map((s) => raw.indexOf(s))
          .filter((i) => i >= 0),
      )
    : -1;
  const hasClock = Boolean(when?.timeText) && !/^(半|[\d一二两三四五六七八九十]+)\s*(分钟|小时|天)后$/.test(when.timeText);
  const timeBeforeGroup = Number.isFinite(timeIndex) && timeIndex >= 0 && timeIndex < groupIndex;
  const explicit = /[：:]/.test(raw);
  const isSchedule =
    Boolean(when) && (timeBeforeGroup || (!explicit && hasClock)) && when.at > now.getTime() + 60000;

  let tail = raw.slice(groupIndex + hit.length);
  if (isSchedule && when) {
    if (when.dateText) tail = removeOnce(tail, when.dateText);
    if (when.timeText) tail = removeOnce(tail, when.timeText);
  }

  tail = tail
    .replace(/^[\s，,：:、]+/, '')
    .replace(/^(?:的)?(?:所有|全体|全部|组内)?(?:员工|成员|同事|人)\s*/, '')
    .replace(/^(?:发个消息|发条消息|发消息|发一条|发一下|通知一下|通知|告诉|转告|说|发|传)\s*[，,：:、]?\s*/, '')
    .replace(/^[，,：:、\s]+/, '');

  return {
    groupName: hit,
    content: cleanRelayContent(tail),
    when,
    isSchedule,
    raw,
  };
}

// ---------------- 队列 ----------------

export function loadQueue() {
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveQueue(list) {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(list.slice(-500), null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

export function addJob(job) {
  const list = loadQueue();
  const item = {
    id: `r${Date.now()}${Math.floor(Math.random() * 1000)}`,
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    ...job,
  };
  list.push(item);
  saveQueue(list);
  return item;
}

export function listJobs() {
  return loadQueue().filter((j) => j.status === 'pending' || j.status === 'failed');
}

export function cancelLatest() {
  const list = loadQueue();
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].status === 'pending') {
      list[i].status = 'cancelled';
      saveQueue(list);
      return list[i];
    }
  }
  return null;
}

export function dueJobs(now = Date.now()) {
  return loadQueue().filter((j) => j.status === 'pending' && j.dueAt <= now);
}

export function updateJob(id, patch) {
  const list = loadQueue();
  const job = list.find((j) => j.id === id);
  if (!job) return null;
  Object.assign(job, patch);
  saveQueue(list);
  return job;
}

export function pruneQueue() {
  const list = loadQueue().filter((j) => {
    if (j.status === 'pending') return true;
    return Date.now() - (j.finishedAt || j.createdAt) < 7 * 86400000;
  });
  saveQueue(list);
}

export function queueFile() {
  return QUEUE_FILE;
}

/** 每 20 秒检查一次到期任务。 */
export function startRelayQueue({ logger, send, onResult, intervalMs = 20000 } = {}) {
  pruneQueue();
  const timer = setInterval(async () => {
    const jobs = dueJobs();
    for (const job of jobs) {
      updateJob(job.id, { status: 'sending', attempts: (job.attempts || 0) + 1 });
      try {
        const result = await send(job);
        updateJob(job.id, {
          status: result?.ok ? 'sent' : 'failed',
          finishedAt: Date.now(),
          result: result?.summary || '',
        });
        if (onResult) await onResult(job, result).catch(() => {});
      } catch (err) {
        const attempts = (job.attempts || 0) + 1;
        if (attempts >= 3) {
          updateJob(job.id, { status: 'failed', finishedAt: Date.now(), result: String(err.message || err) });
        } else {
          updateJob(job.id, { status: 'pending', attempts, dueAt: Date.now() + 60000 * attempts });
        }
        logger?.warn?.(`企微定时传话失败（${job.id}，第 ${attempts} 次）：${err.message}`);
      }
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
