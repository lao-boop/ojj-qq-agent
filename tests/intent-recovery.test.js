import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { IntentRecognizer, normalizeInput, validateIntent } from '../src/agents/intent.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';
import { validateCapabilities } from '../src/agents/capabilities.js';
import { LLM } from '../src/llm.js';

const valid = patch => ({ act: 'create', targetId: '', kind: 'cover', goal: '翻唱指定曲目', agents: ['audio'], operations: ['cover.perform'], forbiddenOperations: [], slots: { source: 'library', title: '30岁的女人', recipient: '纵蔚', delivery: 'unclear' }, exclude: [], missing: [], clarification: '', ...patch });
const input = normalizeInput({ userText: '唱30岁的女人，唱给纵蔚' });

test('recipient survives format repair; ambiguous artist/recipient clarifies without executing', async () => {
  const calls = [], logs = []; let checked = 0;
  const outputs = [valid({ slots: { source: 'library', title: '30岁的女人', recipientName: '纵蔚' } }), valid({})];
  const p = new UnderstandingPipeline({ logger: { warn: message => logs.push(message) }, llm: { chat: async args => { calls.push(args); return { content: JSON.stringify(outputs.shift()) }; } }, validators: { cover: () => { checked++; return {}; } } });
  const result = await p.prepare('test', input);
  assert.match(result.reply, /歌手\/版本/);
  assert.equal(checked, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].responseFormat.type, 'json_object');
  const repairedInput = JSON.parse(calls[1].messages[1].content);
  assert.equal(repairedInput.instruction, input.instruction);
  assert.match(repairedInput.repair.previousOutput, /纵蔚/);
  assert.equal(result.task.slots.title, '30岁的女人');
  assert.equal(result.task.slots.seconds, undefined);
  assert.equal(logs.some(s => /纵蔚/.test(s)), false);
});

test('a truncated response is repaired once without treating partial JSON as an action', async () => {
  let calls = 0;
  const r = await new IntentRecognizer({ chat: async () => calls++ ? { content: JSON.stringify(valid({})) } : { content: '{"act":"create"', finishReason: 'length' } }).recognize(input);
  assert.equal(calls, 2); assert.equal(r.slots.title, '30岁的女人');
});

test('two invalid outputs stop before state creation and produce a format-specific message', async () => {
  let calls = 0;
  const p = new UnderstandingPipeline({ llm: { chat: async () => { calls++; return { content: 'not JSON' }; } } });
  const result = await p.prepare('test', input);
  assert.equal(calls, 2); assert.equal(result.failed, true);
  assert.match(result.reply, /没处理好/); assert.doesNotMatch(result.reply, /任务结构|交付要求|校验/); assert.equal(p.state.list('test').length, 0);
});

for (const [status, pattern] of [[401, /认证/], [402, /额度/], [429, /限流/], [404, /模型不存在/], [400, /请求参数/]]) test(`HTTP ${status} is not retried as a parsing error or exposed verbatim`, async () => {
  let calls = 0; const logs = [];
  const p = new UnderstandingPipeline({ logger: { warn: value => logs.push(value) }, llm: { chat: async () => { calls++; throw Object.assign(new Error('secret-provider-payload'), { status }); } } });
  const result = await p.prepare('test', input);
  assert.equal(calls, 1); assert.match(result.reply, pattern);
  assert.equal(p.state.list('test').length, 0);
  assert.ok(![result.reply, ...logs].join('').includes('secret-provider-payload'));
});

test('non-cover cross-chat delivery stays unsupported; cover delivery requires its dedicated validator', () => {
  assert.match(validateCapabilities(valid({ kind: 'general', slots: { recipient: 'someone', delivery: 'other_chat' } }), input), /不能直接交付/);
  assert.equal(validateCapabilities(valid({ slots: { title: '30岁的女人', recipient: 'someone', delivery: 'other_chat' } }), input), '');
  assert.equal(validateCapabilities(valid({ slots: { title: '30岁的女人', artist: '已确认的歌手', recipient: '', delivery: 'current_chat' } }), input), '');
  assert.throws(() => validateIntent(valid({ slots: { recipient: 'someone', delivery: 'send_anywhere' } })));
});

test('LLM sends JSON response format and exposes truncation reason; opt-out supports older endpoints', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'fake', model: 'test', timeoutMs: 2000 };
  const llm = new LLM(cfg, { debug() {}, warn() {} });
  const request = { messages: [{ role: 'user', content: 'JSON' }], responseFormat: { type: 'json_object' } };
  assert.equal((await llm.chat(request)).finishReason, 'length');
  llm.updateConfig({ ...cfg, jsonMode: false }); await llm.chat(request);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(requests[1].response_format, undefined);
});
