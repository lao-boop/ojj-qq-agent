#!/usr/bin/env node
// Local stdio only. The desktop runner owns the only real recipient.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { ReportService } from '../src/reports.js';
import { LLM } from '../src/llm.js';

const [directory, peer] = process.argv.slice(2);
if (!directory || !peer) throw new Error('需要独立试点数据目录和联系人备注');
const scope = JSON.parse(fs.readFileSync(path.join(directory, 'scope.json'), 'utf8'));
if (scope.mode !== 'single-peer-pilot-v1' || scope.peer !== peer) throw new Error('试点数据身份不匹配');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const pending = new Map();
const staff = 'pilot:reporter', owner = 'pilot:reader';
const logger = { debug() {}, info() {}, warn() { console.error('汇报模块有未确认操作，请查看本机状态。'); }, error() { console.error('汇报模块操作失败，保留已有记录。'); } };
const apiKey = process.env.DEEPSEEK_API_KEY || '';
const llm = apiKey ? new LLM({ apiKey, baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' }, logger) : null;

function send(targetId, text) {
  if (![staff, owner].includes(targetId)) throw new Error('试点禁止跨联系人发送');
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('本机发送确认超时')); }, 19000);
    pending.set(id, { resolve, reject, timer });
    emit({ type: 'send', id, text });
  });
}

const service = new ReportService({
  file: path.join(directory, 'reports.json'), platform: 'wechat-mac-pilot',
  cfg: { enabled: true, bossId: owner, staffIds: [staff], batchIntervalMs: 300000, timezone: 'Asia/Shanghai', useModel: Boolean(apiKey), singlePeerPilot: true },
  connected: () => true, send, llm, logger,
});

async function request(message) {
  if (message.action === 'status') return service.status();
  if (message.action === 'flush') { await service.flush(); return service.status(); }
  if (!/^[A-Z][0-9]{2,6}$/.test(message.requestId || '')) throw new Error('试点请求编号无效');
  if (!['report', 'summary', 'detail'].includes(message.action)) throw new Error('试点操作无效');
  const text = String(message.text || '');
  if (text.length > 2000) throw new Error('试点文字过长');
  if (message.action === 'detail' && !/^R\d{6,}$/.test(text)) throw new Error('汇报编号无效');
  if (message.action === 'summary' && text && !/^第[1-9][0-9]{0,4}页$/.test(text)) throw new Error('汇总页码无效');
  if (message.action === 'report' && !text.trim()) throw new Error('汇报不能为空');
  const input = message.action === 'summary' ? `/汇总 ${text}`.trim() : message.action === 'detail' ? `/详情 ${text}` : text;
  await service.handle({
    post_type: 'message', message_type: 'private', self_id: 'single-peer-pilot',
    user_id: message.action === 'report' ? staff : owner,
    message_id: message.requestId, sender: { nickname: peer },
    report_submission: message.action === 'report',
    message: [{ type: 'text', data: { text: input } }],
    source: { kind: 'screen-ocr', verified: false, observationId: String(message.observationId || message.requestId) },
  });
  return service.status();
}

let chain = Promise.resolve();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { emit({ type: 'protocol-error' }); return; }
  if (message.type === 'send-result') {
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.visible === true) item.resolve(); else item.reject(new Error('本机发送未确认'));
    return;
  }
  if (message.type !== 'request' || typeof message.id !== 'string') return;
  chain = chain.then(async () => {
    try { emit({ type: 'complete', id: message.id, ok: true, status: await request(message) }); }
    catch { emit({ type: 'complete', id: message.id, ok: false, error: '请求未完成；保留已有记录，查看本机状态后再处理。' }); }
  });
});
input.on('close', () => {
  service.stop();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('本机连接中断')); }
  pending.clear();
});
emit({ type: 'ready', modelEnabled: Boolean(apiKey), status: service.status() });
