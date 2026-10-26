import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-state-tests-'));
process.env.QQBOT_DATA = root;
const { ActionJournal, selfContext } = await import('../src/self-state.js');
const { Qzone } = await import('../src/qzone.js');
const { Brain } = await import('../src/brain.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const logger = { info() {}, warn() {} };
const cfg = { bot: { name: '小鲸鱼' }, access: { ownerQQ: '1' }, qzone: { enabled: true, autoPost: true }, chat: { agents: { enabled: true } }, llm: { apiKey: 'secret-not-for-context' } };
function setup(call = async () => ({ tid: 'tid-123' })) {
  const file = path.join(root, `${Math.random()}.json`);
  const journal = new ActionJournal({ file, logger });
  const q = new Qzone({ journal, cfg: { enabled: true, withImage: false }, onebot: { call }, logger, llm: { chat: async () => ({ content: '{"text":"海边的晚风","image":"sea"}' }) } });
  return { file, journal, q };
}

test('automatic post retains actual text, trigger, confirmation and ID after restart', async () => {
  const { q, file } = setup();
  await q.postAuto({ source: 'scheduler' });
  const restored = new ActionJournal({ file });
  const r = restored.visible('private:1', cfg)[0];
  assert.equal(r.status, 'succeeded'); assert.equal(r.content, '海边的晚风');
  assert.equal(r.source, 'scheduler'); assert.equal(r.tid, 'tid-123');
  const context = selfContext({ cfg, journal: restored, chatKey: 'private:1' });
  assert.match(context, /海边的晚风/); assert.ok(!context.includes('secret-not-for-context'));
});
test('in-flight post is running, not succeeded; confirmed success without ID is recorded honestly', async () => {
  let resolve;
  const { q, journal } = setup(() => new Promise(r => resolve = r));
  const promise = q.post({ content: '准备发出', source: 'command', chatKey: 'private:1' });
  assert.equal(journal.records[0].status, 'running');
  resolve({}); await promise;
  assert.equal(journal.records[0].status, 'succeeded'); assert.equal(journal.records[0].tid, '');
});
test('explicit rejection fails; timeout/connection loss remains unknown', async () => {
  for (const [message, status] of [['拒绝（retcode=100）', 'failed'], ['OneBot 未连接', 'failed'], ['OneBot 调用超时', 'unknown'], ['连接已关闭', 'unknown']]) {
    const { q, journal } = setup(async () => { throw new Error(message); });
    await assert.rejects(q.post({ content: '测试' }));
    assert.equal(journal.records[0].status, status);
    assert.equal(q.state.lastPostTid === 'tid-123' || !q.state.lastPostTid, true);
  }
});
test('interrupted actions recover as unknown, never as active forever or successful', () => {
  const { file, journal } = setup(); const id = journal.begin({ content: '尚未确认' });
  journal.update(id, { status: 'running' });
  assert.equal(new ActionJournal({ file }).records[0].status, 'unknown');
});
test('owner can inspect automatic actions; other conversations only see their own actions', async () => {
  const { q, journal } = setup();
  await q.post({ content: '私人动态', source: 'scheduler' });
  await q.post({ content: '当前会话动态', source: 'tool', chatKey: 'private:2' });
  assert.equal(journal.visible('private:1', cfg).length, 2);
  assert.deepEqual(journal.visible('private:2', cfg).map(x => x.content), ['当前会话动态']);
  assert.equal(journal.visible('group:1', cfg).length, 0);
  assert.equal(journal.visible('console:test', cfg).length, 0);
});
test('a journal write failure after successful send does not cause resend or failed result', async () => {
  let sends = 0;
  const { q, journal } = setup(async () => { sends++; journal.save = () => { throw new Error('disk full'); }; return { tid: 'confirmed' }; });
  assert.equal((await q.post({ content: '一次即可' })).tid, 'confirmed');
  assert.equal(sends, 1); assert.equal(journal.records[0].status, 'succeeded');
});
test('corrupt history is not silently discarded', () => {
  const file = path.join(root, 'bad.json'); fs.writeFileSync(file, 'broken');
  assert.throws(() => new ActionJournal({ file })); assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});
for (const enabled of [false, true]) test(`published fact reaches actual chat model contexts (Manager=${enabled})`, async () => {
  const { q, journal } = setup(); await q.postAuto({ topic: '刚刚发布的真实正文', source: 'scheduler' });
  const requests = [];
  const llm = { async chat(args) {
    requests.push(structuredClone(args));
    if (String(args.messages[0].content).includes('第一层多模态')) return { content: JSON.stringify({ act:'chat', targetId:'', kind:'general',operations:['chat.reply'],forbiddenOperations:[], slots:{}, exclude:[], missing:[], goal: '查询刚发的动态', agents: ['conversation'], clarification: '' }) };
    return { content: '刚才定时发了一条动态。' };
  } };
  const brain = new Brain({ cfg: { agents: { enabled } }, llm, logger, tools: { specs: [], run() { throw new Error('Query must not post'); } }, memory: { context: () => ({ notes: [], turns: [] }), append() {}, maybeSummarize: async () => {} }, selfState: chatKey => selfContext({ chatKey, cfg, journal }) });
  const result = await brain.respond({ chatKey: 'private:1', userText: '你刚刚发什么动态了？', meta: { scene: '私聊' } });
  assert.ok(result.bubbles.length);
  assert.equal(requests.length, enabled ? 3 : 1);
  for (const request of requests) {
    assert.ok(JSON.stringify(request).includes('刚刚发布的真实正文'));
    assert.ok(JSON.stringify(request).includes('scheduler'));
  }
  assert.equal(journal.records.length, 1, 'Reading history must not publish again');
});
test('storage failure before sending does not publish', async () => {
  let sends = 0;
  const { q, journal } = setup(async () => { sends++; return {}; });
  journal.save = () => { throw new Error('disk full'); };
  await assert.rejects(q.post({ content: '不要丢失记录' }), /disk full/);
  assert.equal(sends, 0);
});
