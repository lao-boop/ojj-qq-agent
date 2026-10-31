import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function bridge(t, { visible = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-pilot-'));
  fs.writeFileSync(path.join(directory, 'scope.json'), JSON.stringify({ mode: 'single-peer-pilot-v1', peer: '试点联系人' }));
  const child = spawn(process.execPath, ['scripts/mac-pilot-bridge.mjs', directory, '试点联系人'], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, DEEPSEEK_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sent = [], waiting = new Map();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const write = obj => child.stdin.write(JSON.stringify(obj) + '\n');
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'ready') readyResolve(message);
    if (message.type === 'send') { sent.push(message); write({ type: 'send-result', id: message.id, visible }); }
    if (message.type === 'complete') { waiting.get(message.id)?.(message); waiting.delete(message.id); }
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => child.kill(), 1000).unref(); });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, sent, ready, async call(message) {
    await ready;
    const id = randomUUID();
    return new Promise(resolve => { waiting.set(id, resolve); write({ type: 'request', id, ...message }); });
  } };
}

test('single-peer pilot collects, summarizes and returns OCR-labelled details through stdio', { timeout: 10000 }, async t => {
  const app = bridge(t);
  assert.equal((await app.ready).modelEnabled, false);
  const status = await app.call({ action: 'status' });
  assert.equal(status.ok, true);
  assert.equal(status.status.count, 0);
  assert.equal(app.sent.length, 0);
  assert.equal((await app.call({ requestId: 'A01', action: 'report', text: '项目A已交付，尾款周五到账。', observationId: 'frame-1' })).ok, true);
  assert.match(app.sent.at(-1).text, /回复本聊天/);
  assert.ok(!app.sent.at(-1).text.includes('提交老板'));
  assert.equal((await app.call({ requestId: 'Q01', action: 'summary', text: '' })).ok, true);
  assert.match(app.sent.at(-1).text, /项目A已交付/);
  assert.match(app.sent.at(-1).text, /截图识别文字（未人工核对）/);
  assert.match(app.sent.at(-1).text, /详情 Q02 R000001 #END/);
  await app.call({ requestId: 'Q02', action: 'detail', text: 'R000001' });
  assert.match(app.sent.at(-1).text, /本地观察 ID：frame-1/);
  assert.match(app.sent.at(-1).text, /尾款周五到账/);
  const count = app.sent.length;
  await app.call({ requestId: 'A01', action: 'report', text: '项目A已交付，尾款周五到账。' });
  assert.equal(app.sent.length, count);
  await app.call({ action: 'flush' });
  const state = JSON.parse(fs.readFileSync(path.join(app.directory, 'reports.json')));
  assert.equal(state.records.length, 1);
  assert.equal(state.deliveries[0].status, 'sent');
  assert.ok(app.sent.every(m => m.type === 'send' && !Object.hasOwn(m, 'target')));
});

test('pilot rejects unsupported operations and treats explicit report text as data', { timeout: 10000 }, async t => {
  const app = bridge(t);
  assert.equal((await app.call({ requestId: 'A01', action: 'shell', text: 'echo no' })).ok, false);
  assert.equal((await app.call({ requestId: 'Q01', action: 'summary', text: '/重发 D000001' })).ok, false);
  assert.equal((await app.call({ requestId: 'A02', action: 'report', text: '/详情 R999999' })).ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(app.directory, 'reports.json')));
  assert.equal(state.records[0].text, '/详情 R999999');
});

test('failed GUI acknowledgement preserves report and leaves digest delivery unknown', { timeout: 10000 }, async t => {
  const app = bridge(t, { visible: false });
  assert.equal((await app.call({ requestId: 'A01', action: 'report', text: '记录保留。' })).ok, false);
  await app.call({ action: 'flush' });
  const state = JSON.parse(fs.readFileSync(path.join(app.directory, 'reports.json')));
  assert.equal(state.records.length, 1);
  assert.equal(state.deliveries[0].status, 'unknown');
  const count = app.sent.length;
  await app.call({ action: 'flush' });
  assert.equal(app.sent.length, count);
});
