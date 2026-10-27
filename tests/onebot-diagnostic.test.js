import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

for (const hasEvent of [true, false]) test(`read-only OneBot diagnostic distinguishes event stream (${hasEvent}) without disclosing secrets`, { timeout: 5000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diagnostic-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const actions = [];
  server.on('connection', ws => ws.on('message', raw => {
    const req = JSON.parse(raw); actions.push(req.action);
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo, data: { user_id: 30001, nickname: 'not-printed-nickname' } }));
    if (hasEvent) setTimeout(() => ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, message: [{ type: 'text', data: { text: 'private-test-content' } }] })), 20);
  }));
  const configFile = path.join(tmp, 'config.json');
  const original = JSON.stringify({ onebot: { wsUrl: `ws://127.0.0.1:${server.address().port}`, accessToken: 'test-secret-token' }, access: { ownerQQ: '10001' }, llm: { apiKey: 'test-secret-key' } });
  fs.writeFileSync(configFile, original);
  let child, output = '';
  try {
    child = spawn(process.execPath, ['scripts/diagnose_onebot.mjs', '--seconds=1'], { env: { ...process.env, QQBOT_CONFIG: configFile, QQBOT_DATA: path.join(tmp, 'unused-data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    const [code] = await once(child, 'exit');
    assert.equal(code, hasEvent ? 0 : 3, output);
    assert.match(output, hasEvent ? /访问检查通过/ : /登录接口正常，但没有消息事件/);
    assert.deepEqual(actions, ['get_login_info']);
    for (const secret of ['test-secret-token', 'test-secret-key', 'private-test-content', 'not-printed-nickname']) assert.equal(output.includes(secret), false);
    assert.equal(fs.readFileSync(configFile, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(tmp, 'unused-data')), false);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
