import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { LLM } from '../src/llm.js';
import { OneBot } from '../src/onebot.js';
import { AgentManager } from '../src/agents/manager.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';

const logger = { info() {}, debug() {}, warn() {}, error() {} };
for (const mode of ['stalled', 'retryable']) test(`model timeout budget includes retries: ${mode}`, { timeout: 3000 }, async t => {
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; req.resume(); if (mode === 'retryable') { res.statusCode = 503; res.end('unavailable'); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const llm = new LLM({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 200 }, logger);
  const started = Date.now();
  await assert.rejects(llm.chat({ messages: [] }), err => mode === 'stalled' ? err.name === 'TimeoutError' : err.status === 503);
  assert.ok(Date.now() - started < 1200);
  assert.equal(calls, 1);
});

test('injected understanding pipeline receives Manager deadline and configured shorter timeout', async () => {
  const timeouts = [];
  const llm = { cfg: { timeoutMs: 150 }, chat: async args => { timeouts.push(args.timeoutMs); throw new DOMException('timed out', 'TimeoutError'); } };
  const understanding = new UnderstandingPipeline({ llm });
  const manager = new AgentManager({ llm, understanding, logger, config: { timeoutMs: 1000 } });
  const result = await manager.run({ input: { instruction: '你好' }, messages: [], toolCtx: { chatKey: 'private:10001' } });
  assert.equal(result.trace.status, 'failed');
  assert.match(result.reply, /超时/);
  assert.deepEqual(timeouts, [150]);
});

test('QQ disconnect releases pending calls immediately without retrying unknown sends', { timeout: 3000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let sends = 0;
  server.on('connection', ws => ws.on('message', raw => {
    const req = JSON.parse(raw);
    if (req.action === 'get_login_info') ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: req.echo, data: { user_id: 30001 } }));
    else { sends++; ws.close(); }
  }));
  const client = new OneBot({ wsUrl: `ws://127.0.0.1:${server.address().port}`, logger });
  t.after(async () => { client.stop(); for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); });
  const ready = once(client, 'ready'); client.start(); await ready;
  const started = Date.now();
  await assert.rejects(client.sendPrivate(10001, [{ type: 'text', data: { text: 'mock only' } }]), /结果未确认/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(sends, 1); assert.equal(client.pending.size, 0);
});
