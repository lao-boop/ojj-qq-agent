import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';

test('real WeCom app and SDK complete local chat and remember-tool round trips', { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-e2e-'));
  const envKeys = [
    'QQBOT_CONFIG', 'QQBOT_DATA', 'CHAT_PLATFORM', 'WECOM_BOT_ID', 'WECOM_BOT_SECRET',
    'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'REPLICATE_API_TOKEN',
    'ONEBOT_ACCESS_TOKEN', 'ONEBOT_WS_URL', 'CONSOLE_TOKEN',
  ];
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let app;
  let wecomServer;
  let llmServer;
  t.after(async () => {
    app?.stop();
    if (wecomServer) {
      for (const socket of wecomServer.clients) socket.terminate();
      await new Promise((resolve) => wecomServer.close(resolve));
    }
    if (llmServer) {
      llmServer.closeAllConnections();
      await new Promise((resolve) => llmServer.close(resolve));
    }
    globalThis.fetch = originalFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  // config.js loads .env during import. Explicit dummy values prevent local or
  // inherited credentials from entering this fixture; all endpoints are loopback.
  for (const key of envKeys) process.env[key] = 'local-test-placeholder';
  process.env.QQBOT_CONFIG = path.join(dir, 'config.json');
  process.env.QQBOT_DATA = path.join(dir, 'data');
  const { createWecomApp } = await import('../src/wecom-main.js');
  const { DEFAULTS, deepMerge } = await import('../src/config.js');
  const { wecomScope } = await import('../src/wecom-runtime.js');

  const llmRequests = [];
  const httpErrors = [];
  llmServer = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-llm-key');
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      llmRequests.push(body);
      const last = body.messages.at(-1);
      const isBrief = body.messages[0].content.includes('每段都在 sources');
      const isScheduled = body.messages[1]?.content?.startsWith('{"stage":');
      const scheduled = isScheduled ? (await import('../experiments/secretary/wiring-double.js')).wiringResponse(body, '同事说喜欢乌龙茶。') : null;
      const message = scheduled ? {role:'assistant',content:scheduled.content} : isBrief ? {role:'assistant',content:JSON.stringify({paragraphs:[{kind:'fact',text:'同事说喜欢乌龙茶，可以记下这个偏好。',sources:JSON.parse(body.messages[1].content).messages.map(m=>m.id)}]})} : last.role === 'tool' && last.tool_call_id === 'secretary-search'
        ? { role: 'assistant', content: '同事说喜欢乌龙茶，日后招待时可以记一下这个偏好。' }
        : last.role !== 'tool' && last.content.includes('同事说了什么')
          ? { role: 'assistant', content: '', tool_calls: [{ id: 'secretary-search', type: 'function',
            function: { name: 'search_colleague_messages', arguments: '{"query":"乌龙茶"}' } }] }
        : last.role === 'tool'
        ? { role: 'assistant', content: '记住了，你喜欢乌龙茶。' }
        : last.content.includes('乌龙茶')
          ? { role: 'assistant', content: '', tool_calls: [{
            id: 'remember-call', type: 'function',
            function: { name: 'remember', arguments: JSON.stringify({ text: '喜欢乌龙茶' }) },
          }] }
          : { role: 'assistant', content: '我在。' };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } catch (err) {
      httpErrors.push(err);
      response.writeHead(400, { 'Content-Type': 'text/plain' });
      response.end('invalid local test request');
    }
  });
  llmServer.listen(0, '127.0.0.1');
  await once(llmServer, 'listening');
  const llmOrigin = `http://127.0.0.1:${llmServer.address().port}`;
  const externalRequests = [];
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== llmOrigin) {
      externalRequests.push(url.origin);
      return Promise.reject(new Error('External network disabled in WeCom E2E test'));
    }
    return originalFetch(input, options);
  };

  const wire = [];
  const completed = new EventEmitter();
  let peer;
  wecomServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wecomServer, 'listening');
  wecomServer.on('connection', (socket) => {
    peer = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      wire.push(frame);
      socket.send(JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: 'ok' }));
      if (frame.cmd === 'aibot_respond_msg' && frame.body?.stream?.finish) completed.emit(frame.headers.req_id, frame);
    });
  });

  const cfg = deepMerge(structuredClone(DEFAULTS), {
    platform: 'wecom',
    wecom: { botId: 'bot-local-e2e', secret: 'local-bot-secret', mode: 'open',
      secretary: { enabled: true, ownerUserId: 'owner', intervalMinutes: 60 },
      wsUrl: `ws://127.0.0.1:${wecomServer.address().port}`, maxReconnectAttempts: 0, requestTimeoutMs: 5000 },
    llm: { baseUrl: `${llmOrigin}/v1`, apiKey: 'local-llm-key', model: 'local-model', timeoutMs: 2000 },
    chat: { retrieval: true, summaryTriggerChars: 100000, maxBubbles: 1 },
    image: { enabled: false }, tts: { enabled: false }, song: { enabled: false },
    console: { enabled: false }, log: { level: 'error', file: false },
  });
  await fs.writeFile(process.env.QQBOT_CONFIG, JSON.stringify(cfg));
  app = createWecomApp({ cfg });
  const ready = once(app.transport, 'ready');
  app.start();
  await ready;
  assert.equal(app.transport.status().connected, true);
  assert.equal(Boolean(app.consoleServer.server?.listening), false);
  assert.deepEqual(wire[0].body, { bot_id: 'bot-local-e2e', secret: 'local-bot-secret' });

  const chatKey = `${wecomScope(cfg.wecom.botId)}private:employee.alpha`;
  async function roundTrip(id, content, userId = 'employee.alpha') {
    const finished = once(completed, id);
    peer.send(JSON.stringify({
      cmd: 'aibot_msg_callback', headers: { req_id: id },
      body: { msgid: `message-${id}`, aibotid: cfg.wecom.botId, chattype: 'single',
        from: { userid: userId }, msgtype: 'text', text: { content } },
    }));
    const [reply] = await finished;
    // The server has acknowledged delivery; wait for runtime to persist it.
    await app.runtime.chains.get(`${wecomScope(cfg.wecom.botId)}private:${userId}`);
    return reply;
  }

  const first = await roundTrip('chat-1', '在吗');
  assert.equal(first.body.stream.content, '我在。');
  const second = await roundTrip('chat-2', '请记住我喜欢乌龙茶');
  assert.equal(second.body.stream.content, '记住了，你喜欢乌龙茶。');
  assert.equal(app.runtime.status().replied, 2);
  assert.equal(llmRequests.length, 3);
  assert.deepEqual(llmRequests[2].messages.at(-1), { role: 'tool', tool_call_id: 'remember-call', content: '记住了：喜欢乌龙茶' });
  assert.ok(llmRequests[0].tools.some((tool) => tool.function.name === 'remember'));
  assert.equal(llmRequests[0].tools.some((tool) => ['post_qzone', 'relay_to_friend', 'mc_connect'].includes(tool.function.name)), false);
  const session = app.memory.get(chatKey);
  assert.deepEqual(session.notes.map((note) => note.text), ['喜欢乌龙茶']);
  for (const turn of session.turns.filter(t => t.role === 'user')) {
    assert.match(turn.content, /employee.alpha/);
    assert.match(turn.content, /receivedTime/);
  }
  assert.deepEqual(session.turns.map(({ role, content }) => ({ role, content: role === 'user' ? content.split('[消息正文]\n').slice(1).join('[消息正文]\n') : content })), [
    { role: 'user', content: '在吗' }, { role: 'assistant', content: '我在。' },
    { role: 'user', content: '请记住我喜欢乌龙茶' }, { role: 'assistant', content: '记住了，你喜欢乌龙茶。' },
  ]);
  const diskSessions = await fs.readdir(path.join(dir, 'data', 'sessions'));
  assert.equal(diskSessions.length, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'data', 'sessions', diskSessions[0]), 'utf8'));
  assert.equal(persisted.key, chatKey);
  assert.equal(persisted.notes[0].text, '喜欢乌龙茶');
  assert.equal(llmRequests[0].tools.some(tool => tool.function.name === 'search_colleague_messages'), false);
  const owner = await roundTrip('owner-query', '同事说了什么？', 'owner');
  assert.match(owner.body.stream.content, /喜欢乌龙茶/);
  assert.doesNotMatch(owner.body.stream.content, /来源原文|M[a-f0-9]{20}|UserID/);
  const sources = await roundTrip('owner-sources', '/来源', 'owner');
  assert.match(sources.body.stream.content, /employee.alpha/);
  assert.match(sources.body.stream.content, /请记住我喜欢乌龙茶/);
  assert.ok(llmRequests[3].tools.some(tool => tool.function.name === 'search_colleague_messages'));
  app.secretary.now = () => Date.now() + 3600001;
  await app.secretary.tick();
  const reports = wire.filter(frame => frame.cmd === 'aibot_send_msg');
  assert.ok(reports.length > 0);
  assert.ok(reports.every(frame => frame.body.chatid === 'owner'));
  assert.ok(reports.some(frame => frame.body.markdown.content.includes('乌龙茶')));
  assert.equal(app.secretary.status().pending, 0);
  assert.deepEqual(httpErrors, []);
  assert.deepEqual(externalRequests, []);
});
