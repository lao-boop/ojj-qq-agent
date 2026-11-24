import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';

/**
 * 企业微信原文档案：每条消息一个稳定来源编号，按 Bot ID 隔离目录。
 * 汇报只能引用这里存在的来源，且 quote 必须是原文连续片段。
 */

export function wecomScope(botId) {
  return createHash('sha256').update(String(botId || 'unconfigured')).digest('hex').slice(0, 16);
}

export function wecomDataDir(botId, dataDir = DATA_DIR) {
  return path.join(dataDir, 'wecom', wecomScope(botId));
}

function sourceFile(botId, dataDir) {
  return path.join(wecomDataDir(botId, dataDir), 'sources.jsonl');
}

export function sourceId({ at, userid, text }) {
  return 'M' + createHash('sha1').update(`${at}|${userid}|${text}`).digest('hex').slice(0, 12).toUpperCase();
}

export function archiveSource({
  botId,
  userid,
  name = '',
  chattype = '',
  chatid = '',
  text = '',
  at = Date.now(),
  dataDir = DATA_DIR,
}) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const record = {
    id: sourceId({ at, userid, text: clean }),
    botId: String(botId || ''),
    at: Number(at) || Date.now(),
    userid: String(userid || ''),
    name: String(name || '').slice(0, 40),
    chattype: String(chattype || ''),
    chatid: String(chatid || '').slice(0, 80),
    text: clean.slice(0, 2000),
  };
  const file = sourceFile(botId, dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    // 只保留最近 5000 条，避免无限增长
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length > 5000) fs.writeFileSync(file, lines.slice(-5000).join('\n') + '\n', 'utf8');
    return record;
  } catch {
    return null;
  }
}

export function listSources(botId, { since = 0, dataDir = DATA_DIR } = {}) {
  const file = sourceFile(botId, dataDir);
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.at >= since)
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

export function findSource(botId, id, { dataDir = DATA_DIR } = {}) {
  return listSources(botId, { dataDir }).find((s) => s.id === id) || null;
}

export function validateQuote(source, quote) {
  const q = String(quote || '').trim();
  if (!source || !q) return false;
  return String(source.text || '').includes(q);
}

export function validateEvidence(botId, evidence, { dataDir = DATA_DIR } = {}) {
  const results = [];
  for (const e of evidence || []) {
    const source = findSource(botId, e?.source, { dataDir });
    if (!source || !validateQuote(source, e?.quote)) {
      return { ok: false, error: `来源或引文不成立：${e?.source || '空'}` };
    }
    results.push(source);
  }
  return { ok: results.length > 0, sources: results };
}

/**
 * 把旧的 wecom-activity.jsonl 回填到分 Bot 的原文档案。
 * 只回填最近 days 天；按来源编号去重，可重复执行。
 */
export function backfillFromActivity({ botId, dataDir = DATA_DIR, days = 7 } = {}) {
  const activity = path.join(DATA_DIR, 'wecom-activity.jsonl');
  if (!fs.existsSync(activity)) return 0;
  const since = Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
  const existing = new Set(listSources(botId, { dataDir }).map((s) => s.id));
  let added = 0;
  const lines = fs.readFileSync(activity, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r?.text || !r.at || r.at < since) continue;
    const id = sourceId({ at: r.at, userid: r.userid, text: r.text });
    if (existing.has(id)) continue;
    const rec = archiveSource({
      botId,
      userid: r.userid,
      name: r.name,
      chattype: r.chattype,
      chatid: r.chatid,
      text: r.text,
      at: r.at,
      dataDir,
    });
    if (rec) {
      existing.add(rec.id);
      added++;
    }
  }
  return added;
}
