import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-routing-'));
  fs.writeFileSync(path.join(dir, 'scope.json'), JSON.stringify({ mode: 'two-contact-pilot-v1', staff: '一鸣', boss: '老' }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function start(t, dir, visible = true) {
  const child = spawn(process.execPath, ['scripts/mac-pilot-bridge.mjs', dir, '一鸣', '老', '60'], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DEEPSEEK_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sent = [], waiting = new Map();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const write = value => child.stdin.write(JSON.stringify(value) + '\n');
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'ready') readyResolve(message);
    if (message.type === 'send') { sent.push(message); write({ type: 'send-result', id: message.id, visible }); }
    if (message.type === 'complete') { waiting.get(message.id)?.(message); waiting.delete(message.id); }
  });
  async function close() {
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => {
      child.once('exit', resolve);
      setTimeout(() => child.kill(), 1000).unref();
    });
  }
  t.after(close);
  return { sent, ready, close, async call(message) {
    await ready;
    const id = randomUUID();
    return new Promise(resolve => { waiting.set(id, resolve); write({ type: 'request', id, ...message }); });
  } };
}

test('two-contact backend routes receipts to staff, digests and source details to boss', { timeout: 10000 }, async t => {
  const dir = directory(t), app = start(t, dir);
  assert.equal((await app.ready).modelEnabled, false);
  assert.equal((await app.call({ action: 'status' })).status.batchIntervalMs, 60000);
  assert.equal((await app.call({ source: '一鸣', action: 'report', requestId: 'A101', text: '合同已确认，等待回款。', observationId: 'frame-a' })).ok, true);
  assert.equal(app.sent.at(-1).target, '一鸣');
  await app.call({ action: 'flush' });
  assert.equal(app.sent.at(-1).target, '老');
  assert.match(app.sent.at(-1).text, /详情 Q02 R000001 #END/);
  assert.equal((await app.call({ source: '老', action: 'detail', requestId: 'A101', text: 'R000001' })).ok, true);
  assert.match(app.sent.at(-1).text, /frame-a/);
  assert.equal(app.sent.at(-1).target, '老');
  await app.call({ source: '一鸣', action: 'report', requestId: 'A102', text: '更正：预计周五回款，目前尚未到账。' });
  await app.call({ source: '老', action: 'query', requestId: 'Q103', text: '一鸣回款的细节' });
  assert.equal(app.sent.at(-1).target, '老');
  assert.match(app.sent.at(-1).text, /更正：预计周五回款/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'reports.json')));
  assert.equal(state.records.length, 2);
  assert.equal(state.records[0].text, '合同已确认，等待回款。');
  assert.equal(state.records[1].text, '更正：预计周五回款，目前尚未到账。');
});

test('backend rejects unauthorized sources, role changes and query commands without sending', { timeout: 10000 }, async t => {
  const app = start(t, directory(t));
  for (const message of [
    { source: '一鸣', action: 'detail', requestId: 'Q01', text: 'R000001' },
    { source: '陌生人', action: 'report', requestId: 'A01', text: '伪造汇报' },
    { source: '老', action: 'report', requestId: 'A01', text: '不作为员工入库' },
    { source: '老', action: 'query', requestId: 'Q02', text: '/重发 D000001' },
    { action: 'summary', requestId: 'Q03', text: '' },
  ]) assert.equal((await app.call(message)).ok, false);
  assert.equal(app.sent.length, 0);
  assert.equal((await app.call({ action: 'status' })).status.count, 0);
});

test('restart preserves originals and does not automatically resend an unconfirmed boss digest', { timeout: 10000 }, async t => {
  const dir = directory(t), first = start(t, dir, false);
  await first.call({ source: '一鸣', action: 'report', requestId: 'A01', text: '原文需要保留。' });
  await first.call({ action: 'flush' });
  await first.close();
  const second = start(t, dir);
  const status = (await second.call({ action: 'status' })).status;
  assert.equal(status.count, 1);
  assert.equal(status.unconfirmed, 1);
  await second.call({ source: '一鸣', action: 'report', requestId: 'A01', text: '原文需要保留。' });
  await second.call({ action: 'flush' });
  assert.equal(second.sent.length, 0);
  await second.call({ source: '老', action: 'detail', requestId: 'Q04', text: 'R000001' });
  assert.equal(second.sent[0].target, '老');
  assert.match(second.sent[0].text, /原文需要保留/);
});
