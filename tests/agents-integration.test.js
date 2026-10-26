import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

// Exercise actual index -> Brain -> intent -> Manager -> tools -> ReplySender, using local model/QQ servers.
for (const {enabled, cover} of [{enabled:true,cover:false},{enabled:false,cover:false},{enabled:true,cover:true}]) test(`real bot validates input and delivery (Manager=${enabled}, cover=${cover})`, { timeout: 20000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-integration-'));
  const requests = [], delivered = [];
  let stage = 0, bot, logs = '';
  const model = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); requests.push(data);
    const system = data.messages[0]?.content || '';
    let message = { role: 'assistant', content: '' };
    if (typeof system === 'string' && system.includes('第一层多模态')) {
      message.content = JSON.stringify(cover ? {act:'create',targetId:'',kind:'cover',operations:['cover.perform'],forbiddenOperations:[],slots:{title:'乡愁四韵',artist:'罗大佑'},exclude:[],missing:[],goal:'翻唱乡愁四韵',agents:['audio'],clarification:''} : { act:'create', targetId:'', kind:'general', operations:['image.generate'],forbiddenOperations:[], slots:{prompt:'a cute cat'}, exclude:[], missing:[], goal: '画一只猫', agents: ['image'], clarification: '' });
    } else if ((typeof system === 'string' && system.includes('内部 image Agent')) || (!enabled && data.tools?.length)) {
      if (stage++ === 0) message.tool_calls = [{ id: 'draw-1', type: 'function', function: { name: 'draw_image', arguments: JSON.stringify({ prompt: 'a cute cat' }) } }];
      else message.content = '图片已生成';
    } else if (data.messages.some(m => String(m.content).includes('你是主管'))) message.content = '画好了，给你。';
    else if (Array.isArray(system)) message.content = '图片中是一只猫。';
    else message.content = JSON.stringify({ bad: false, issue: '' });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const onebot = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(onebot, 'listening');
  onebot.on('connection', ws => {
    ws.on('message', raw => {
      const r = JSON.parse(raw);
      const data = r.action === 'get_login_info' ? { user_id: 30001, nickname: 'mock' } : { message_id: 123 };
      if (r.action === 'send_private_msg') delivered.push(r.params);
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: r.echo, data }));
      if (r.action === 'get_login_info') setTimeout(() => ws.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 30001, message_id: 99, sender: { nickname: 'tester' }, message: [{ type: 'text', data: { text: cover ? '唱罗大佑的乡愁四韵。' : '参考这张图画一只猫。' } }, { type: 'image', data: { file: path.resolve('assets/sample-image.jpg') } }] })), 50);
    });
  });
  const musicDir = path.join(tmp,'music'); fs.mkdirSync(musicDir);
  fs.writeFileSync(path.join(musicDir,'罗大佑-光阴的故事.mp3'), 'not real audio; must never be executed');
  const config = {
    onebot: { wsUrl: `ws://127.0.0.1:${onebot.address().port}` },
    llm: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: '', timeoutMs: 3000 },
    chat: { agents: { enabled }, firstDelayMs: [0,0], splitDelayMs: [0,0] },
    access: { privateAllow: ['10001'] }, image: { provider: 'mock', cooldownMs: 0 },
    console: { enabled: false }, log: { file: false }, library: { enabled: cover, dir: musicDir }, voice: { enabled: cover, token: 'local-test-placeholder' }, qzone: { enabled: false }, asr: { enabled: false, local: { enabled: false } },
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));
  try {
    bot = spawn(process.execPath, ['src/index.js'], { cwd: process.cwd(), env: { ...process.env, QQBOT_CONFIG: path.join(tmp, 'config.json'), QQBOT_DATA: path.join(tmp, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    bot.stdout.on('data', b => logs += b); bot.stderr.on('data', b => logs += b);
    const end = Date.now() + 14000;
    while (Date.now() < end && !delivered.some(m => m.message.some(s => cover ? String(s.data?.text).includes('准确匹配') : s.type === 'image'))) await new Promise(r => setTimeout(r, 50));
    if (cover) {
      assert.ok(delivered.some(m => m.message.some(s => String(s.data?.text).includes('准确匹配'))), logs);
      assert.equal(delivered.flatMap(m => m.message).filter(s => ['record','image'].includes(s.type)).length,0);
      assert.ok(requests.some(r => String(r.messages[0].content).includes('第一层多模态')));
      return;
    }
    assert.ok(delivered.some(m => m.message.some(s => s.type === 'image')), logs);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(delivered.flatMap(m => m.message).filter(s => s.type === 'image').length, 1);
    assert.equal(requests.some(r => String(r.messages[0].content).includes('第一层多模态')), enabled);
    if (enabled) {
      const recognition = requests.find(r => String(r.messages[0].content).includes('第一层多模态'));
      const envelope = JSON.parse(recognition.messages[1].content);
      assert.equal(envelope.imageCount, 1);
      assert.match(envelope.caption, /猫/);
    assert.ok(requests.some(r => String(r.messages[0].content).includes('内部 image Agent')));
    assert.match(logs, /Agent task .*completed/);
    }
  } finally {
    if (bot && bot.exitCode === null) { bot.kill('SIGTERM'); await once(bot, 'exit'); }
    for (const client of onebot.clients) client.terminate();
    await new Promise(r => onebot.close(r));
    await new Promise(r => model.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
