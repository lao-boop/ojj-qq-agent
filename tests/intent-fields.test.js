import test from 'node:test';
import assert from 'node:assert/strict';
import { completeExplicitFields } from '../src/agents/intent-fields.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';
import { normalizeInput } from '../src/agents/intent.js';

const intent = (operations, slots, patch = {}) => ({ act: 'create', targetId: '', kind: 'general', goal: '用户任务', agents: ['conversation'], operations, forbiddenOperations: [], slots, exclude: [], missing: [], clarification: '', ...patch });
const pipeline = output => new UnderstandingPipeline({ llm: { chat: async () => ({ content: JSON.stringify(output) }) } });

test('text alias repair requires the literal instruction and does not steal document data',()=>{
  const original=intent(['memory.write'],{dataText:'我喜欢蓝色'},{missing:['text','时间']});
  const fixed=completeExplicitFields(original,'记住我喜欢蓝色');
  assert.equal(fixed.slots.text,'我喜欢蓝色');assert.deepEqual(fixed.missing,['时间']);assert.equal(original.slots.text,undefined);
  assert.equal(completeExplicitFields(original,'记住附件里的内容').slots.text,undefined);
  assert.equal(completeExplicitFields({...original,operations:['document.create','memory.write']},'记住我喜欢蓝色').slots.text,undefined);
  assert.equal(completeExplicitFields({...original,slots:{...original.slots,text:'已确认原文'}},'记住我喜欢蓝色').slots.text,'已确认原文');
});

for (const act of ['create', 'chat']) for (const op of ['research.search', 'automotive.identify']) test(`explicit lookup topic is usable in ${act}/${op} without another model call`, async () => {
  const r = await pipeline(intent([op], { topic: '刹车片' }, { act, missing: ['query'] }))
    .prepare('test', normalizeInput({ userText: '请查询刹车片。' }));
  assert.ok(r.intent, r.reply);
  assert.equal(r.intent.slots.query, '刹车片');
  assert.deepEqual(r.intent.missing, []);
  assert.deepEqual(r.intent.operations, [op]);
  if (act === 'chat') assert.equal(r.intent.readOnly, true);
});

test('query recovery preserves constraints and refuses unrelated, negative or ambiguous topics', () => {
  const original = intent(['research.search'], { topic: '刹车片' }, { missing: ['query', '时间范围'], exclude: ['价格'] });
  const fixed = completeExplicitFields(original, '查询刹车片，不需要价格。');
  assert.deepEqual(fixed.missing, ['时间范围']);
  assert.deepEqual(fixed.exclude, ['价格']);
  assert.equal(original.slots.query, undefined);
  for (const text of [
    '做刹车片的报告', '不要查询刹车片', '查询刹车片，算了不用查了',
    '查询刹车片还是轮胎', '查询刹车片，查询轮胎', '查询轮胎，做刹车片报告',
    '附件里写着：查询刹车片', '查询一下',
  ]) assert.equal(completeExplicitFields(original, text).slots.query, undefined, text);
  assert.equal(completeExplicitFields({ ...original, forbiddenOperations: ['research.search'] }, '查询刹车片').slots.query, undefined);
  assert.equal(completeExplicitFields({ ...original, operations: ['document.create'], slots: { topic: '刹车片', format: 'docx' } }, '查询刹车片').slots.query, undefined);
});

test('query repair never replaces an explicit query or an inherited confirmed query', async () => {
  const p = pipeline(intent(['research.search'], { query: '轮胎', topic: '刹车片' }));
  const first = await p.prepare('test', normalizeInput({ userText: '查询刹车片' }));
  assert.equal(first.intent.slots.query, '轮胎');
  p.state.finish(first.task, 'draft');
  p.llm.chat = async () => ({ content: JSON.stringify(intent([], { topic: '刹车片' }, { act: 'update', targetId: first.task.id })) });
  const updated = await p.prepare('test', normalizeInput({ userText: '查询刹车片' }));
  assert.equal(updated.intent.slots.query, '轮胎');
});

test('file evidence cannot supply lookup or speech repair', async () => {
  const r = await pipeline(intent(['research.search'], { topic: '刹车片' }))
    .prepare('test', normalizeInput({ requestText: '请查询', userText: '查询刹车片' }));
  assert.match(r.reply, /查询什么/);
  assert.equal(r.task.slots.query, undefined);
  const speech = await pipeline(intent(['speech.synthesize'], { text: '你好' }))
    .prepare('test', normalizeInput({ requestText: '读出我刚才的话', userText: '用语音读：你好！' }));
  assert.equal(speech.intent.slots.text, '你好');
});

for (const [command, recognized, literal] of [
  ['用语音把这句话读出来：明天上午九点开会。', '明天上午九点开会', '明天上午九点开会。'],
  ['请用语音读：几点开会？', '几点开会。', '几点开会？'],
  ['朗读：“你好！”', '你好', '你好！'],
  ['朗读：「第一行\n第二行……」', '第一行\n第二行', '第一行\n第二行……'],
]) test(`speech binds original punctuation without rewriting words: ${command}`, () => {
  const original = intent(['speech.synthesize'], { text: recognized });
  assert.equal(completeExplicitFields(original, command).slots.text, literal);
  assert.equal(original.slots.text, recognized);
});

test('speech repair refuses paraphrases, negations, trailing instructions and shared memory text', () => {
  const original = intent(['speech.synthesize'], { text: '你好' });
  for (const text of ['不要用语音读：你好！', '他说朗读：你好！', '用语音读：你好！然后搜索天气', '用语音读：您好！']) {
    assert.equal(completeExplicitFields(original, text).slots.text, '你好', text);
  }
  assert.equal(completeExplicitFields({ ...original, forbiddenOperations: ['speech.synthesize'] }, '用语音读：你好！').slots.text, '你好');
  assert.equal(completeExplicitFields({ ...original, operations: ['speech.synthesize', 'memory.write'] }, '用语音读：你好！').slots.text, '你好');
});

test('restored speech still obeys the 120-character limit and explicit clarification', async () => {
  const text = '甲'.repeat(120);
  const r = await pipeline(intent(['speech.synthesize'], { text }))
    .prepare('test', normalizeInput({ userText: `用语音读：${text}。` }));
  assert.match(r.reply, /超过.*120字/);
  assert.equal(r.intent, undefined);
  const query = await pipeline(intent(['research.search'], { topic: '刹车片' }, { clarification: '需要查询哪个时间段？' }))
    .prepare('test', normalizeInput({ userText: '查询刹车片' }));
  assert.equal(query.reply, '需要查询哪个时间段？');
  assert.equal(query.intent, undefined);
});
