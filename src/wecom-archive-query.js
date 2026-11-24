import { listSources } from './wecom-source-archive.js';

export const ARCHIVE_QUERY_MAX = 50;

function fmtTime(at) {
  return new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function clip(text, n = 300) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 仅查询“员工发给本机器人”的原文，不读员工之间的聊天。
 * @param {object} opts
 * @param {string} opts.botId
 * @param {string} opts.ownerUserId 查询者；结果会排除 owner 自己的消息
 * @param {string} opts.person 员工姓名或 userid，必填
 * @param {string} [opts.keyword]
 * @param {number} [opts.days=7]
 * @param {number} [opts.limit=20]
 * @param {'private'|'group'|'all'} [opts.scope='private']
 * @param {string} [opts.dataDir]
 */
export function queryArchive({
  botId,
  ownerUserId,
  person,
  keyword = '',
  days = 7,
  limit = 20,
  scope = 'private',
  dataDir,
}) {
  const p = String(person || '').trim();
  if (!p) {
    return { ok: false, error: '要查哪位员工？' };
  }
  const n = Math.max(1, Math.min(ARCHIVE_QUERY_MAX, Number(limit) || 20));
  const d = Math.max(1, Math.min(90, Number(days) || 7));
  const since = Date.now() - d * 24 * 60 * 60 * 1000;
  const kw = String(keyword || '').trim();
  const owner = String(ownerUserId || '').trim();
  const all = listSources(botId, { since, dataDir });
  const matched = all.filter((s) => {
    if (owner && String(s.userid) === owner) return false;
    if (scope === 'private' && s.chattype !== 'single') return false;
    if (scope === 'group' && s.chattype !== 'group') return false;
    const name = String(s.name || '');
    const uid = String(s.userid || '');
    if (!(name === p || name.includes(p) || uid === p || uid.includes(p))) return false;
    if (kw && !String(s.text || '').includes(kw)) return false;
    return true;
  });
  const rows = matched.slice(-n);
  const lines = rows.map(
    (s) => `[${s.id}] ${fmtTime(s.at)} ${s.name || s.userid}：${clip(s.text)}`,
  );
  const header = `近 ${d} 天，${p} 发给机器人的${scope === 'group' ? '群' : scope === 'all' ? '' : '私聊'}消息：${rows.length} 条（上限 ${ARCHIVE_QUERY_MAX}）`;
  return {
    ok: true,
    count: rows.length,
    limit: n,
    totalMatched: matched.length,
    text: rows.length ? `${header}\n${lines.join('\n')}` : `${header}\n没有找到记录。`,
    rows,
  };
}
