import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WeComTransport, WeComSender, wecomChatId } from '../src/wecom.js';

const frame = { headers: { req_id: 'request-1' }, body: { msgid: 'message-1', chattype: 'single', from: { userid: 'user.alice' }, msgtype: 'text', text: { content: '你好' } } };

const PROXY_ENV_KEYS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'];

function proxyEnv(t, values = {}) {
  const previous = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

async function localConnectProxy(t, targetPort, { deny = false } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => res.writeHead(405).end());
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  server.on('connection', track);
  server.on('connect', (req, downstream, head) => {
    requests.push(req.url);
    // Never turn a test fixture into a general-purpose or remote proxy.
    if (deny || req.url !== `127.0.0.1:${targetPort}`) {
      downstream.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = track(net.connect({ host: '127.0.0.1', port: targetPort }, () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    }));
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

class FakeClient extends EventEmitter {
  constructor(options) { super(); this.options = options; this.calls = []; }
  connect() { this.emit('connected'); }
  authenticate() { this.emit('authenticated'); }
  disconnect() { this.calls.push(['disconnect']); }
  async replyStream(...args) { this.calls.push(['replyStream', ...args]); return { errcode: 0 }; }
  async sendMessage(...args) { this.calls.push(['sendMessage', ...args]); return { errcode: 0 }; }
  async uploadMedia(...args) { this.calls.push(['uploadMedia', ...args]); return { media_id: 'media-1' }; }
  async sendMediaMessage(...args) { this.calls.push(['sendMediaMessage', ...args]); return { errcode: 0 }; }
}

function setup(t, cfg = {}) {
  const clients = [];
  const logs = [];
  const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => logs.push(args.join(' '))]));
  const transport = new WeComTransport({
    cfg: { enabled: true, botId: 'bot-test', secret: 'private-secret', ...cfg }, logger,
    clientFactory: (options) => { const client = new FakeClient(options); clients.push(client); return client; },
  });
  t.after(() => transport.stop());
  transport.start();
  return { transport, clients, logs, sender: new WeComSender({ transport, logger }) };
}

test('disabled or unconfigured transport creates no network client', (t) => {
  for (const cfg of [{ enabled: false }, { secret: '' }, { botId: '' }]) {
    const { transport, clients } = setup(t, cfg);
    assert.equal(clients.length, 0);
    assert.equal(transport.status().connected, false);
  }
});

test('omitting enabled starts the explicitly selected WeCom transport', (t) => {
  const { transport, clients } = setup(t, { enabled: undefined });
  assert.equal(clients.length, 1);
  assert.equal(transport.status().enabled, true);
  clients[0].authenticate();
  assert.equal(transport.status().connected, true);
  transport.stop();
  assert.equal(transport.status().state, 'stopped');
});

test('requires authentication, forwards raw callbacks, and does not reconnect after takeover', async (t) => {
  const { transport, clients, sender } = setup(t);
  const client = clients[0];
  assert.equal(transport.status().state, 'authenticating');
  await assert.rejects(sender.replyText(frame, 'hi'), /未连接|未认证/);
  client.authenticate();
  const message = once(transport, 'message');
  client.emit('message', frame);
  assert.equal((await message)[0], frame);
  client.emit('event', { body: { event: { eventtype: 'disconnected_event' } } });
  client.emit('disconnected', 'replaced');
  assert.equal(transport.status().state, 'replaced');
  assert.equal(clients.length, 1);
  await assert.rejects(sender.sendText(frame, 'hi'), /未连接/);
});

test('redacts credentials and suppresses SDK raw callback debug logs', (t) => {
  const { transport, clients, logs } = setup(t);
  clients[0].options.logger.debug('callback secret-body aeskey=abc123');
  clients[0].options.logger.warn('secret=private-secret url=https://example.test/private?token=hidden');
  clients[0].emit('error', new Error('secret=private-secret aeskey=abc123'));
  const text = JSON.stringify({ logs, status: transport.status() });
  for (const value of ['private-secret', 'abc123', 'secret-body', 'hidden']) assert.equal(text.includes(value), false);
});

test('selects inherited proxies by WebSocket scheme and keeps TLS verification enabled', (t) => {
  proxyEnv(t, { HTTPS_PROXY: 'http://secure-proxy.test:8443', HTTP_PROXY: 'http://plain-proxy.test:8080' });
  const secure = setup(t);
  const plain = setup(t, { wsUrl: 'ws://gateway.test:8081' });
  assert.ok(secure.clients[0].options.wsOptions.agent instanceof HttpsProxyAgent);
  assert.equal(secure.clients[0].options.wsOptions.agent.proxy.href, 'http://secure-proxy.test:8443/');
  assert.equal(plain.clients[0].options.wsOptions.agent.proxy.href, 'http://plain-proxy.test:8080/');
  for (const client of [secure.clients[0], plain.clients[0]]) {
    assert.equal(client.options.wsOptions.handshakeTimeout, 15000);
    assert.notEqual(client.options.wsOptions.rejectUnauthorized, false);
    assert.notEqual(client.options.wsOptions.agent.connectOpts.rejectUnauthorized, false);
  }
  const destroy = t.mock.method(secure.clients[0].options.wsOptions.agent, 'destroy');
  secure.transport.stop();
  assert.equal(destroy.mock.callCount(), 1);
});

test('honors lowercase proxy precedence, ALL_PROXY, and NO_PROXY host and port matches', (t) => {
  proxyEnv(t, {
    HTTPS_PROXY: 'http://upper-proxy.test:8080', https_proxy: 'http://lower-proxy.test:8080',
    ALL_PROXY: 'http://fallback-proxy.test:8080', NO_PROXY: 'localhost,127.0.0.1,gateway.test:8443',
  });
  assert.equal(setup(t).clients[0].options.wsOptions.agent.proxy.hostname, 'lower-proxy.test');
  for (const wsUrl of ['ws://127.0.0.1:3001', 'wss://localhost:3001', 'wss://gateway.test:8443']) {
    assert.equal(setup(t, { wsUrl }).clients[0].options.wsOptions.agent, undefined);
  }
  assert.ok(setup(t, { wsUrl: 'wss://gateway.test:9443' }).clients[0].options.wsOptions.agent);
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  assert.equal(setup(t).clients[0].options.wsOptions.agent.proxy.hostname, 'fallback-proxy.test');
  process.env.no_proxy = '*';
  assert.equal(setup(t).clients[0].options.wsOptions.agent, undefined);
});

test('does not pass malformed proxy configuration to a direct network client', (t) => {
  proxyEnv(t, { HTTPS_PROXY: 'http://private-user:private-password@' });
  const { transport, clients, logs } = setup(t);
  assert.equal(clients.length, 0);
  assert.equal(transport.status().state, 'failed');
  assert.match(transport.status().lastError, /代理地址无效/);
  assert.equal(JSON.stringify(logs).includes('private-password'), false);
});

test('routes groups and string user IDs correctly; stops queued sends after shutdown', async (t) => {
  const { transport, clients, sender } = setup(t);
  const client = clients[0];
  client.authenticate();
  assert.equal(wecomChatId(frame), 'user.alice');
  assert.throws(() => wecomChatId({ body: { chattype: 'group', from: { userid: 'user.alice' } } }), /会话 ID/);
  const group = { ...frame, body: { ...frame.body, chattype: 'group', chatid: 'group:abc' } };
  await sender.sendText(group, '群聊');
  assert.equal(client.calls[0][1], 'group:abc');
  const pending = sender.sendText(frame, '不应发送');
  transport.stop();
  await assert.rejects(pending, /未连接/);
  assert.equal(client.calls.filter((call) => call[0] === 'sendMessage').length, 1);
});

test('preserves a stream ID; media upload uses active delivery and MP3 is a file', async (t) => {
  const { clients, sender } = setup(t);
  const client = clients[0];
  client.authenticate();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'image.png');
  const audio = path.join(dir, 'voice.mp3');
  await Promise.all([fs.writeFile(image, 'png'), fs.writeFile(audio, 'audio')]);
  const streamId = await sender.replyText(frame, '处理中', { finish: false, streamId: 'stream-1' });
  await sender.sendResult(frame, { bubbles: ['第一条', '第二条'], images: [{ file: image }], voices: [{ file: audio }] }, { streamId });
  const replies = client.calls.filter((call) => call[0] === 'replyStream');
  assert.deepEqual(replies.map((call) => [call[2], call[4]]), [['stream-1', false], ['stream-1', true]]);
  assert.equal(replies[1][3], '第一条\n\n第二条');
  assert.deepEqual(client.calls.filter((call) => call[0] === 'uploadMedia').map((call) => call[2].type), ['image', 'file']);
  assert.deepEqual(client.calls.filter((call) => call[0] === 'sendMediaMessage').map((call) => call[1]), ['user.alice', 'user.alice']);
});

test('media delivery failures propagate, and shutdown during upload prevents delivery', async (t) => {
  const { transport, clients, sender } = setup(t);
  const client = clients[0];
  client.authenticate();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.txt');
  await fs.writeFile(file, 'report');
  client.sendMediaMessage = async () => { throw new Error('delivery rejected'); };
  await assert.rejects(sender.sendFile(frame, file), /delivery rejected/);
  client.uploadMedia = async () => { transport.stop(); return { media_id: 'uploaded' }; };
  await assert.rejects(sender.sendFile(frame, file), /未连接/);
});

test('proactive result sends text without using an expired callback or stream ID', async (t) => {
  const { clients, sender } = setup(t);
  const client = clients[0];
  client.authenticate();
  const expired = { body: frame.body };
  const text = '你好😀'.repeat(1000);
  await sender.sendResult(expired, { bubbles: [text] }, { streamId: 'expired-stream', proactive: true });
  assert.equal(client.calls.some((call) => call[0] === 'replyStream'), false);
  const messages = client.calls.filter((call) => call[0] === 'sendMessage');
  assert.ok(messages.length > 1);
  assert.equal(messages.map((call) => call[2].markdown.content).join(''), text);
  assert.ok(messages.every((call) => call[1] === 'user.alice' && Buffer.byteLength(call[2].markdown.content) <= 4096));
});

test('a result queued beyond its callback deadline switches to active delivery', async (t) => {
  const { clients, sender } = setup(t);
  const client = clients[0];
  client.authenticate();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const normalSend = client.sendMessage.bind(client);
  client.sendMessage = async (...args) => {
    if (args[1].markdown.content === '前一条') await gate;
    return normalSend(...args);
  };
  const previous = sender.sendText(frame, '前一条');
  const deadlineAt = Date.now() + 15;
  const result = sender.sendResult(frame, { bubbles: ['排队后的结果'] }, { streamId: 'expired', deadlineAt });
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await Promise.all([previous, result]);
  assert.equal(client.calls.some((call) => call[0] === 'replyStream'), false);
  assert.deepEqual(client.calls.filter((call) => call[0] === 'sendMessage').map((call) => call[2].markdown.content), ['前一条', '排队后的结果']);
});

test('real SDK authenticates and sends replies/media through a loopback WebSocket only', { timeout: 10000 }, async (t) => {
  proxyEnv(t, { NO_PROXY: '127.0.0.1,localhost' });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const received = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      received.push(data);
      const reply = { headers: data.headers, errcode: 0, errmsg: 'ok' };
      if (data.cmd === 'aibot_upload_media_init') reply.body = { upload_id: 'upload-local' };
      if (data.cmd === 'aibot_upload_media_finish') reply.body = { media_id: 'media-local', type: 'file' };
      socket.send(JSON.stringify(reply));
      if (data.cmd === 'aibot_subscribe') socket.send(JSON.stringify({ ...frame, cmd: 'aibot_msg_callback' }));
    });
  });
  const transport = new WeComTransport({ cfg: { enabled: true, botId: 'local-bot', secret: 'local-secret', wsUrl: `ws://127.0.0.1:${server.address().port}`, maxReconnectAttempts: 0 } });
  t.after(async () => {
    transport.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const message = once(transport, 'message');
  transport.start();
  const [incoming] = await message;
  const sender = new WeComSender({ transport });
  await sender.replyText(incoming, '本地回复', { streamId: 'local-stream' });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.txt');
  await fs.writeFile(file, 'local report');
  await sender.sendFile(incoming, file, 'report.txt');
  assert.deepEqual(received[0].body, { bot_id: 'local-bot', secret: 'local-secret' });
  const response = received.find((item) => item.cmd === 'aibot_respond_msg');
  assert.equal(response.headers.req_id, 'request-1');
  assert.deepEqual(response.body.stream, { id: 'local-stream', finish: true, content: '本地回复' });
  const sent = received.find((item) => item.cmd === 'aibot_send_msg');
  assert.deepEqual(sent.body, { chatid: 'user.alice', msgtype: 'file', file: { media_id: 'media-local' } });
});

test('real SDK authenticates and receives reply acknowledgements through a local CONNECT proxy', { timeout: 10000 }, async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let transport;
  t.after(async () => {
    transport?.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const received = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      received.push(data);
      socket.send(JSON.stringify({ headers: data.headers, errcode: 0, errmsg: 'ok' }));
      if (data.cmd === 'aibot_subscribe') socket.send(JSON.stringify({ ...frame, cmd: 'aibot_msg_callback' }));
    });
  });
  const proxy = await localConnectProxy(t, server.address().port);
  proxyEnv(t, { HTTP_PROXY: proxy.url });
  transport = new WeComTransport({ cfg: {
    botId: 'proxy-local-bot', secret: 'proxy-local-secret',
    wsUrl: `ws://127.0.0.1:${server.address().port}`, maxReconnectAttempts: 0,
  } });
  const message = once(transport, 'message');
  transport.start();
  const [incoming] = await message;
  assert.equal(transport.status().authenticated, true);
  await new WeComSender({ transport }).replyText(incoming, '经本地代理回复', { streamId: 'proxy-stream' });
  assert.deepEqual(proxy.requests, [`127.0.0.1:${server.address().port}`]);
  assert.deepEqual(received[0].body, { bot_id: 'proxy-local-bot', secret: 'proxy-local-secret' });
  const reply = received.find((item) => item.cmd === 'aibot_respond_msg');
  assert.equal(reply.headers.req_id, frame.headers.req_id);
  assert.deepEqual(reply.body.stream, { id: 'proxy-stream', finish: true, content: '经本地代理回复' });
});

test('proxy denial fails without falling back to a reachable direct WebSocket', { timeout: 10000 }, async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let directConnections = 0;
  let transport;
  server.on('connection', () => { directConnections++; });
  t.after(async () => {
    transport?.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const proxy = await localConnectProxy(t, server.address().port, { deny: true });
  proxyEnv(t, { HTTP_PROXY: proxy.url });
  transport = new WeComTransport({ cfg: {
    botId: 'denied-local-bot', secret: 'denied-local-secret',
    wsUrl: `ws://127.0.0.1:${server.address().port}`, maxReconnectAttempts: 0,
  } });
  const failure = once(transport, 'error');
  transport.start();
  const [error] = await failure;
  assert.match(error.message, /403/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(proxy.requests, [`127.0.0.1:${server.address().port}`]);
  assert.equal(directConnections, 0);
  assert.equal(transport.status().authenticated, false);
});

test('generic document results upload real files and revalidate permission after upload',async t=>{
 const {sender,clients}=setup(t);const client=clients[0];client.authenticate();
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wecom-generic-file-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'summary.docx');await fs.writeFile(file,'real file bytes');
 await sender.sendResult(frame,{bubbles:['文件已准备'],files:[{path:file,name:'summary.docx'}]});
 assert.equal(client.calls.filter(c=>c[0]==='sendMediaMessage').length,1);
 let allowed=true;
 client.uploadMedia=async()=>{allowed=false;return {media_id:'revoked'};};
 await assert.rejects(sender.sendFile(frame,file,'summary.docx',{validate:()=>allowed}),/权限/);
 assert.equal(client.calls.filter(c=>c[0]==='sendMediaMessage').length,1);
});
