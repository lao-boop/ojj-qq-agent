import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

for (const mode of ['tts', 'asr', 'asr-disabled']) test(`real QQ message pipeline: ${mode}`, { timeout: 20000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-integration-'));
  const delivered = [], requests = [];
  let bot, logs = '';
  // 40 seconds of valid PCM WAV: the previous 30-second heuristic skipped this.
  const samples = 16000 * 40;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(path.join(tmp, 'memo.wav'), wav);
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1400, 12)]);
  const transcript = '明天下午三点开项目会议';
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, data });
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/transcribe') return res.end(JSON.stringify({ text: transcript }));
    if (req.url === '/v1/t2a_v2') return res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } }));
    const system = String(data.messages?.[0]?.content || '');
    const content = system.includes('第一层多模态') ? JSON.stringify({ act: 'chat', targetId: '', kind: 'general', goal: '复述语音内容', agents: ['conversation'], operations: ['chat.reply'], forbiddenOperations: [], slots: {}, exclude: [], missing: [], clarification: '' }) : (mode === 'asr-disabled' ? '语音识别未启用，无法听取内容。' : `收到：${transcript}`);
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${model.address().port}`;
  const onebot = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(onebot, 'listening');
  onebot.on('connection', ws => ws.on('message', raw => {
    const r = JSON.parse(raw);
    if (r.action === 'send_private_msg') delivered.push(r.params);
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: r.echo, data: r.action === 'get_login_info' ? { user_id: 30001, nickname: 'test' } : { message_id: 1 } }));
    if (r.action === 'get_login_info') setTimeout(() => ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 30001, message_id: 2, sender: { nickname: 'owner' }, message: mode === 'tts' ? [{ type: 'text', data: { text: '/say 明天下午三点开会' } }] : [{ type: 'record', data: { name: 'memo.wav', file: '/app/.config/QQ/memo.wav' } }] })), 40);
  }));
  const cfg = {
    onebot: { wsUrl: `ws://127.0.0.1:${onebot.address().port}` },
    llm: { baseUrl, apiKey: 'fake-text-key', model: 'text-test' }, vision: { enabled: false },
    chat: { agents: { enabled: true }, firstDelayMs: [0, 0], splitDelayMs: [0, 0] },
    access: { privateAllow: ['10001'], adminQQ: ['10001'] },
    files: { pathMappings: [{ remote: '/app/.config/QQ', local: tmp }] },
    tts: { enabled: mode === 'tts', provider: 'minimax', minimax: { baseUrl, apiKey: 'fake-voice-key', model: 'voice-test', voiceId: 'voice-1' } },
    asr: { enabled: mode === 'asr', token: '', local: { enabled: true, url: baseUrl } },
    image: { enabled: false }, song: { enabled: false }, voice: { enabled: false }, library: { enabled: false }, qzone: { enabled: false }, console: { enabled: false }, log: { file: false },
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  try {
    bot = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, QQBOT_DATA: path.join(tmp, 'data'), QQBOT_CONFIG: path.join(tmp, 'config.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    bot.stdout.on('data', b => logs += b); bot.stderr.on('data', b => logs += b);
    const done = () => delivered.some(m => m.message.some(s => mode === 'tts' ? s.type === 'record' : /收到：|语音识别未启用/.test(s.data?.text || '')));
    const end = Date.now() + 12000;
    while (!done() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(done(), logs);
    if (mode === 'tts') {
      const record = delivered.flatMap(m => m.message).find(s => s.type === 'record');
      assert.deepEqual(Buffer.from(record.data.file.slice(9), 'base64'), audio);
      assert.equal(requests.filter(r => r.url === '/v1/t2a_v2').length, 1);
    } else {
      assert.equal(requests.filter(r => r.url === '/transcribe').length, mode === 'asr' ? 1 : 0);
      const intentRequest = requests.find(r => String(r.data.messages?.[0]?.content).includes('第一层多模态'));
      const input = JSON.parse(intentRequest.data.messages[1].content);
      if (mode === 'asr') assert.equal(input.instruction, transcript);
      else assert.match(input.evidence, /语音识别当前关闭/);
    }
  } finally {
    if (bot && bot.exitCode === null) { bot.kill('SIGTERM'); await once(bot, 'exit'); }
    for (const client of onebot.clients) client.terminate();
    await new Promise(resolve => onebot.close(resolve));
    await new Promise(resolve => model.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
