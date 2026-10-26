import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

for (const deliveryMode of ['current', 'recipient', 'rejected']) test(`spoken next-audio request waits and delivers only subsequent audio: ${deliveryMode}`, { timeout: 25000 }, async () => {
  const direct = deliveryMode !== 'current';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-pipeline-'));
  let bot, logs = '', predictions = 0, transcriptions = 0, nextSent = false, baseUrl;
  const delivered = [], captured = [];
  const source = path.join(tmp, 'source.wav'), preparation = path.join(tmp, 'prepare.wav'), result = path.join(tmp, 'result.mp3');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', source]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', preparation]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, result]);
  const resultBytes = fs.readFileSync(result);
  const api = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end('{"ok":true,"model":"medium"}');
    if (req.url === '/transcribe') return res.end(JSON.stringify({ text: transcriptions++ === 0 ? `做好准备，翻唱我下一条语音${direct ? '，翻唱后私发给阿明' : ''}` : '这是一段清唱' }));
    if (req.url === '/files') return res.end(JSON.stringify({ urls: { get: `${baseUrl}/source` } }));
    if (req.url === '/predictions') { predictions++; captured.push(JSON.parse(raw)); return res.end(JSON.stringify({ id: 'test-task', status: 'succeeded', output: `${baseUrl}/result` })); }
    if (req.url === '/result') { res.setHeader('Content-Type', 'audio/mpeg'); return res.end(resultBytes); }
    const request = JSON.parse(raw);
    const input = JSON.parse(request.messages[1].content);
    captured.push(input);
    const waiting = input.tasks?.find(t => t.slots.source === 'next_audio');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ act: waiting ? 'update' : 'create', targetId: waiting?.id || '', kind: 'cover', goal: '翻唱指定音频', agents: ['audio'], operations: ['cover.perform'], forbiddenOperations: [], slots: { source: waiting ? 'attachment' : 'next_audio', ...(!waiting && direct ? { recipient: '阿明', delivery: 'other_chat' } : {}) }, exclude: [], missing: [], clarification: '' }) } }] }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${api.address().port}`;
  const onebot = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(onebot, 'listening');
  const sendAudio = (ws, file, id) => ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 30001, message_id: id, sender: { nickname: 'owner' }, message: [{ type: 'record', data: { name: path.basename(file), file } }] }));
  let premature = false;
  onebot.on('connection', ws => ws.on('message', raw => {
    const req = JSON.parse(raw);
    const reject = deliveryMode === 'rejected' && req.action === 'send_private_msg' && req.params.user_id === 20002;
    ws.send(JSON.stringify({ status: reject ? 'failed' : 'ok', retcode: reject ? 1 : 0, echo: req.echo, data: req.action === 'get_login_info' ? { user_id: 30001, nickname: 'test' } : req.action === 'get_friend_list' ? [{ user_id: 20002, nickname: '阿明' }] : { message_id: 77 } }));
    if (req.action === 'get_login_info') setTimeout(() => direct
      ? ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 30001, message_id: 90, sender: { nickname: 'owner' }, message: [{ type: 'text', data: { text: '/收歌人 20002 阿明' } }] }))
      : sendAudio(ws, preparation, 1), 50);
    if (req.action === 'send_private_msg') {
      delivered.push(...req.params.message.map(s => ({ ...s, userId: req.params.user_id })));
      if (req.params.message.some(s => /已登记收歌人/.test(s.data?.text || ''))) setTimeout(() => sendAudio(ws, preparation, 1), 50);
      if (!nextSent && req.params.message.some(s => /等你下一条|等待下一条/.test(s.data?.text || ''))) {
        premature = predictions !== 0;
        nextSent = true; setTimeout(() => sendAudio(ws, source, 2), 50);
      }
    }
  }));
  const config = {
    onebot: { wsUrl: `ws://127.0.0.1:${onebot.address().port}` }, llm: { baseUrl, apiKey: 'fake', model: 'fake' },
    chat: { agents: { enabled: true }, firstDelayMs: [0, 0], splitDelayMs: [0, 0] }, access: { privateAllow: ['10001'], ownerQQ: '10001' },
    voice: { enabled: true, token: 'fake', apiBase: baseUrl, version: 'pinned', rvcModel: 'Preset', recipients: [] },
    asr: { enabled: true, local: { enabled: true, url: baseUrl, model: 'medium' } },
    qzone: { enabled: false }, library: { enabled: false }, image: { enabled: false }, tts: { enabled: false }, song: { enabled: false }, console: { enabled: false }, log: { file: false },
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));
  try {
    bot = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, QQBOT_CONFIG: path.join(tmp, 'config.json'), QQBOT_DATA: path.join(tmp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    bot.stdout.on('data', b => logs += b); bot.stderr.on('data', b => logs += b);
    const end = Date.now() + 18000;
    const finished = () => direct ? delivered.some(s => s.userId === 10001 && (deliveryMode === 'rejected' ? /这次翻唱未完成/ : /QQ 接口已确认/).test(s.data?.text || '')) : delivered.some(s => s.type === 'record');
    while (Date.now() < end && !finished()) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(finished(), logs);
    assert.ok(nextSent, logs); assert.equal(premature, false);
    assert.equal(predictions, 1, logs);
    const record = delivered.find(s => s.type === 'record'); assert.ok(record, logs);
    assert.equal(delivered.filter(s => s.type === 'record').length, 1);
    assert.equal(record.userId, direct ? 20002 : 10001);
    assert.deepEqual(Buffer.from(record.data.file.slice(9), 'base64'), resultBytes);
    assert.equal(captured.find(r => r.version)?.input.rvc_model, 'Preset');
    assert.equal(captured.filter(r => r.actorId === '10001').length, 2);
    if (direct) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'))).voice.recipients, [{ qq: '20002', name: '阿明' }]);
      assert.equal(delivered.filter(s => s.userId === 20002).length, 1);
      const receipts = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'cover-deliveries.json'), 'utf8'));
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].status, deliveryMode === 'rejected' ? 'failed' : 'sent');
      assert.equal(receipts[0].qq, '20002');
      if (deliveryMode === 'rejected') assert.equal(delivered.some(s => /翻唱已发送给|翻唱已交付/.test(s.data?.text || '')), false);
    }
  } finally {
    if (bot && bot.exitCode === null) { bot.kill('SIGTERM'); await once(bot, 'exit'); }
    for (const ws of onebot.clients) ws.terminate();
    await new Promise(resolve => onebot.close(resolve)); await new Promise(resolve => api.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
