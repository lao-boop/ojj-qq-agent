import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

for (const managed of [true, false]) test(`owner-only configuration replies to chat and status at rate limit (Manager=${managed})`, { timeout: 12000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-response-'));
  let bot, socket, logs = '', calls = 0;
  const sent = [];
  const api = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls++;
    const request = JSON.parse(body);
    const intent = String(request.messages[0]?.content).includes('第一层多模态');
    const content = intent ? JSON.stringify({ act: 'chat', targetId: '', kind: 'general', goal: '日常聊天', agents: ['conversation'], operations: ['chat.reply'], forbiddenOperations: [], slots: {}, exclude: [], missing: [], clarification: '' }) : '你好，收到你的消息了。';
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const qq = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(qq, 'listening');
  const message = (id, text) => socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: id, self_id: 30001, message_id: Date.now(), sender: { nickname: 'tester' }, message: [{ type: 'text', data: { text } }] }));
  qq.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw);
      if (req.action === 'send_private_msg') sent.push(req.params);
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo, data: req.action === 'get_login_info' ? { user_id: 30001, nickname: 'bot' } : { message_id: 123 } }));
      if (req.action === 'get_login_info') setTimeout(() => { message(20002, '你好！'); message(10001, '你好！'); }, 30);
    });
  });
  const config = {
    onebot: { wsUrl: `ws://127.0.0.1:${qq.address().port}` },
    llm: { baseUrl: `http://127.0.0.1:${api.address().port}`, apiKey: 'fake', timeoutMs: 1000 },
    access: { ownerQQ: '10001', adminQQ: [], privateAllow: [], allowAllWhenEmpty: false },
    chat: { agents: { enabled: managed }, rateLimit: { perChatPerMinute: 1 }, firstDelayMs: [0,0], splitDelayMs: [0,0] },
    console: { enabled: false }, log: { file: false }, qzone: { enabled: false }, asr: { enabled: false, local: { enabled: false } },
    image: { enabled: false }, tts: { enabled: false }, song: { enabled: false }, voice: { enabled: false }, library: { enabled: false },
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));
  const waitFor = async predicate => { const end = Date.now() + 3500; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 30)); assert.ok(predicate(), logs); };
  try {
    bot = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, QQBOT_CONFIG: path.join(tmp, 'config.json'), QQBOT_DATA: path.join(tmp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    bot.stdout.on('data', b => logs += b); bot.stderr.on('data', b => logs += b);
    await waitFor(() => sent.some(m => m.message.some(s => s.data?.text?.includes('收到你的消息'))));
    const callsBeforeStatus = calls;
    message(10001, '/status');
    await waitFor(() => sent.some(m => m.message.some(s => s.data?.text?.includes('连接：正常'))));
    assert.equal(calls, callsBeforeStatus);
    assert.ok(sent.every(m => m.user_id === 10001));
  } finally {
    if (bot && bot.exitCode === null) { bot.kill('SIGTERM'); await once(bot, 'exit'); }
    for (const ws of qq.clients) ws.terminate();
    await new Promise(resolve => qq.close(resolve)); await new Promise(resolve => api.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
