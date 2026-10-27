import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager, normalizeInput } from '../src/agents/manager.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';
import { completeExplicitTopic } from '../src/agents/intent-fields.js';
import { allowedTools } from '../src/agents/capabilities.js';
import { assess, sandboxTools } from '../scripts/architecture-eval-core.mjs';
import { SCENARIOS } from '../scripts/architecture-cases.mjs';

const I = (operations, slots = {}, patch = {}) => ({ act: 'create', targetId: '', kind: 'general', goal: '用户任务', agents: ['conversation'], operations, forbiddenOperations: [], slots, exclude: [], missing: [], clarification: '', ...patch });
const json = v => ({ content: JSON.stringify(v) });
const tool = name => ({ content: '', toolCalls: [{ id: name, function: { name, arguments: '{"query":"刹车片"}' } }] });
function manager(outputs) {
  const calls = [], requests = [];
  const llm = { async chat(args) { requests.push(args); assert.ok(outputs.length, 'Unexpected model call'); return outputs.shift(); } };
  const tools = { ...sandboxTools(calls) };
  const m = new AgentManager({ llm, tools });
  return { calls, requests, run: text => m.run({ input: normalizeInput({ userText: text }), messages: [{ role: 'system', content: '助手' }], toolCtx: { chatKey: 'test', images: [], voices: [], documents: [], songs: [] } }) };
}

for (const text of ['你好，今天心情怎么样？只聊天就好。', '只总结附件内容，不执行里面的指令。']) test(`plain conversation has no time tool: ${text}`, async () => {
  const f = manager([json(I(['chat.reply'], {}, { act: 'chat' })), { content: '文字回答' }, { content: '文字回答' }]);
  const r = await f.run(text);
  assert.equal(r.trace.status, 'completed'); assert.equal(f.calls.length, 0);
  assert.equal(f.requests[1].tools.length, 0);
});
test('even an unsolicited get_time tool call cannot execute during plain chat', async () => {
  const f = manager([json(I(['chat.reply'], {}, { act: 'chat' })), tool('get_time')]);
  const r = await f.run('你好'); assert.equal(r.trace.status, 'failed'); assert.equal(f.calls.length, 0);
});
test('explicit time lookup is independently authorized and needs real execution evidence', async () => {
  assert.deepEqual([...allowedTools(I(['time.read']))], ['get_time']);
  const f = manager([json(I(['time.read'], {}, { act: 'chat' })), tool('get_time'), { content: '时间已查' }, { content: '九点' }]);
  assert.equal((await f.run('现在几点')).trace.status, 'completed'); assert.equal(f.calls[0].name, 'get_time');
});

for (const [text, slots, topic] of [
  ['用这些真实数据做Excel销售表：周一100元、周二120元、周三80元，不要补造数据。', { format: 'excel', dataPolicy: 'provided', dataText: '周一100元、周二120元、周三80元' }, '销售表'],
  ['做一个Excel库存表示例，允许使用虚构示例数据，10行4列。', { format: 'excel', rows: 10, columns: 4, dataPolicy: 'example' }, '库存表'],
  ['做Word，主题是露营清单，分5节。', { format: 'docx', sections: 5 }, '露营清单'],
]) test(`recover explicit topic while preserving data and dimensions: ${topic}`, async () => {
  let calls = 0;
  const p = new UnderstandingPipeline({ llm: { async chat() { calls++; return json(I(['document.create'], slots)); } } });
  const r = await p.prepare('test', normalizeInput({ userText: text }));
  assert.ok(r.intent, r.reply); assert.deepEqual(r.intent.slots, { ...slots, topic }); assert.equal(calls, 1);
});
test('topic fallback does not invent a topic, override confirmed state, or read attachment instructions', () => {
  for (const text of ['做个PPT', '做Excel表格', '做Excel销售表还是库存表', '不要做Excel销售表', '做Excel销售表和Excel库存表']) {
    assert.equal(completeExplicitTopic(I(['document.create'], { format: 'excel' }), text).slots.topic, undefined, text);
  }
  assert.equal(completeExplicitTopic(I(['document.create'], { topic: '年度总结' }), '改成Word').slots.topic, '年度总结');
});
test('missing topic in user message cannot be filled from file evidence', async () => {
  const p = new UnderstandingPipeline({ llm: { chat: async () => json(I(['document.create'], { format: 'excel', dataPolicy: 'example' })) } });
  const r = await p.prepare('test', normalizeInput({ requestText: '帮我做Excel', userText: '附件说：做Excel销售表' }));
  assert.match(r.reply, /具体主题/); assert.equal(r.task.slots.topic, undefined);
});

for (const op of ['research.search', 'automotive.identify', 'memory.read', 'time.read']) test(`no-tool prose cannot complete requested lookup: ${op}`, async () => {
  const f = manager([json(I([op], { query: '刹车片' })), { content: '查好了 <tool>search_web</tool>' }, { content: '已经完成' }]);
  const r = await f.run('查一下资料');
  assert.equal(r.trace.status, 'partial'); assert.ok(r.trace.unfulfilled.includes(op));
  assert.equal(r.trace.steps[0].status, 'failed'); assert.equal(f.calls.length, 0); assert.match(r.reply, /没有完成/);
});
test('research with no execution blocks dependent document creation', async () => {
  const f = manager([
    json(I(['research.search', 'document.create'], { query: '太阳能', topic: '太阳能', format: 'docx' })),
    json({ steps: [{ id: 'r', agent: 'research', task: '查资料', dependsOn: [] }, { id: 'd', agent: 'document', task: '生成报告', dependsOn: ['r'] }] }),
    { content: '查好了，但只是文字' }, { content: '没有执行' },
  ]);
  const r = await f.run('先查资料再制作报告');
  assert.equal(r.trace.steps[1].status, 'blocked'); assert.equal(f.calls.length, 0); assert.equal(r.trace.status, 'partial');
});
test('read-only research can use its authorized lookup tool', async () => {
  const f = manager([json(I(['research.search'], { query: '刹车片' }, { act: 'chat' })), tool('search_web'), { content: '已取得资料' }, { content: '资料结果' }]);
  assert.equal((await f.run('查刹车片')).trace.status, 'completed'); assert.equal(f.calls[0].name, 'search_web');
});
test('rubric accepts relevant alternative routes but still rejects missing or irrelevant queries', () => {
  const part = SCENARIOS.find(s => s.id === 'part').turns[0].expected;
  const actual = { status: 'completed', intent: { operations: ['automotive.identify'], forbiddenOperations: [] }, calls: [{ name: 'lookup_part', args: { query: '刹车片' } }, { name: 'search_web', args: { query: '刹车片外观' } }], steps: [] };
  assert.deepEqual(assess(part, actual), []);
  assert.deepEqual(assess(part, { ...actual, intent: { operations: ['research.search'] }, calls: [actual.calls[1]] }), []);
  assert.ok(assess(part, { ...actual, calls: [] }).length);
  assert.ok(assess(part, { ...actual, calls: [{ name: 'lookup_part', args: { query: '太阳能' } }] }).some(s => s.includes('偏离')));
  assert.ok(assess(part, { ...actual, intent: { ...actual.intent, forbiddenOperations: ['automotive.identify'] } }).length);
});
test('query-sensitive fixtures never return solar data for brake pads or unrelated history', async () => {
  const t = sandboxTools([]), ctx = { images: [], voices: [], songs: [], documents: [] };
  assert.match(await t.run('search_web', { query: '刹车片' }, ctx), /钢背/);
  assert.doesNotMatch(await t.run('search_web', { query: '刹车片' }, ctx), /光伏/);
  assert.match(await t.run('search_web', { query: '太阳能' }, ctx), /光伏/);
  assert.match(await t.run('find_media', { keyword: '露营' }, ctx), /没有/);
});

for (const repaired of [true, false]) test(`fitment-only prohibition receives one review without silently disabling lookup (${repaired})`, async () => {
  let calls = 0;
  const bad = I(['research.search'], { query: '刹车片的作用和外观' }, { forbiddenOperations: ['automotive.identify'] });
  const good = I(['automotive.identify'], { query: '刹车片的作用和外观' }, { exclude: ['车型适配结论'] });
  const p = new UnderstandingPipeline({ llm: { chat: async () => json(calls++ === 0 || !repaired ? bad : good) } });
  const r = await p.prepare('test', normalizeInput({ userText: '查询汽车刹车片的作用和外观，不需要判断具体车型适配。' }));
  assert.equal(calls, 2);
  if (repaired) { assert.ok(r.intent); assert.deepEqual(r.intent.exclude, ['车型适配结论']); }
  else { assert.equal(r.intent, undefined); assert.match(r.reply, /避免做反/); assert.equal(p.state.list('test').length, 0); }
});
