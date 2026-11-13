import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';

const previousDataDir = process.env.QQBOT_DATA;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-office-test-'));
process.env.QQBOT_DATA = dataDir;
const { Office } = await import('../src/office.js');
const builder = path.join(dataDir, 'fake-builder.mjs');
const buildLog = path.join(dataDir, 'builds.jsonl');

// Exercise the real subprocess boundary without Python dependencies or model calls.
fs.writeFileSync(builder, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const specPath = process.argv[3];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const log = path.join(path.dirname(fileURLToPath(import.meta.url)), 'builds.jsonl');
fs.appendFileSync(log, JSON.stringify({ specPath, out: spec.out, title: spec.title }) + '\\n');
if (spec.title === 'slow-build') await new Promise(resolve => setTimeout(resolve, 10000));
fs.writeFileSync(spec.out, spec.title.padEnd(3200, '.'));
`, { mode: 0o700 });

after(() => {
  if (previousDataDir === undefined) delete process.env.QQBOT_DATA;
  else process.env.QQBOT_DATA = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const builds = () => fs.existsSync(buildLog)
  ? fs.readFileSync(buildLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const logger = { info() {}, warn() {} };
const docxResponse = title => ({ content: JSON.stringify({ title, sections: [{ heading: '测试', paragraphs: ['正文'] }] }) });
const slidesResponse = () => ({ content: JSON.stringify({
  title: '演示文稿',
  slides: Array.from({ length: 4 }, (_, i) => ({ title: `第 ${i + 1} 页`, bullets: ['要点'], imagePrompt: 'a landscape' })),
}) });
function officeFixture(overrides = {}) {
  return new Office({
    cfg: { imagesPerDeck: 4, imageDelayMs: 0 }, logger, pythonPath: builder,
    llm: { chat: async ({ messages }) => docxResponse(messages.at(-1).content.replace('主题：', '')) },
    ...overrides,
  });
}

test('simultaneous documents keep separate specs and output even in the same millisecond', async (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const before = builds().length;
  const [a, b] = await Promise.all([
    officeFixture().makeDocx({ topic: '用户 A 的文件' }),
    officeFixture().makeDocx({ topic: '用户 B 的文件' }),
  ]);
  assert.notEqual(a.file, b.file);
  assert.ok(fs.readFileSync(a.file, 'utf8').startsWith('用户 A 的文件'));
  assert.ok(fs.readFileSync(b.file, 'utf8').startsWith('用户 B 的文件'));
  const rows = builds().slice(before);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map(row => row.specPath)).size, 2);
  assert.ok(rows.every(row => !fs.existsSync(row.specPath)));
});

test('already-canceled Word, Excel and PPT jobs make no model or image requests', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const before = builds().length;
  const office = officeFixture({
    llm: { chat: async () => { calls++; return docxResponse('不应生成'); } },
    imageGen: { generate: async () => { calls++; return { file: 'unused' }; } },
  });
  for (const method of ['makeDocx', 'makeExcel', 'makePpt']) {
    await assert.rejects(office[method]({ topic: '取消', signal: controller.signal }), { name: 'AbortError' });
  }
  assert.equal(calls, 0);
  assert.equal(builds().length, before);
});

test('canceling an outline request prevents retry, the second batch, images and build', async () => {
  for (const rejectRequest of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    let images = 0;
    const before = builds().length;
    const office = officeFixture({
      llm: { chat: async () => {
        calls++;
        controller.abort();
        if (rejectRequest) throw new Error('request failed');
        return slidesResponse();
      } },
      imageGen: { generate: async () => { images++; return { file: 'unused' }; } },
    });
    await assert.rejects(office.makePpt({ topic: '取消', pages: 4, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(images, 0);
    assert.equal(builds().length, before);
  }
});

test('Word and Excel stop after an in-flight model response when canceled', async () => {
  for (const method of ['makeDocx', 'makeExcel']) {
    const controller = new AbortController();
    const before = builds().length;
    const office = officeFixture({ llm: { chat: async () => {
      controller.abort();
      return { content: 'intentionally invalid JSON: cancellation must take precedence' };
    } } });
    await assert.rejects(office[method]({ topic: '取消', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(builds().length, before);
  }
});

test('canceling an image request prevents later images and the document build', async () => {
  const controller = new AbortController();
  let images = 0;
  const before = builds().length;
  const office = officeFixture({
    llm: { chat: async () => slidesResponse() },
    imageGen: { generate: async () => { images++; controller.abort(); return { file: 'unused' }; } },
  });
  await assert.rejects(office.makePpt({ topic: '取消', pages: 4, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(images, 1);
  assert.equal(builds().length, before);
});

test('cancel interrupts inter-image and throttling waits without another paid request', { timeout: 2000 }, async () => {
  for (const throttled of [false, true]) {
    const controller = new AbortController();
    let images = 0;
    const before = builds().length;
    const office = officeFixture({
      llm: { chat: async () => slidesResponse() },
      imageGen: { generate: async () => {
        images++;
        setImmediate(() => controller.abort());
        if (throttled) throw new Error('429 rate limit');
        return { file: 'unused' };
      } },
    });
    await assert.rejects(office.makePpt({ topic: '取消', pages: 4, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(images, 1);
    assert.equal(builds().length, before);
  }
});

test('signals remain scoped to their own jobs when one Office instance is reused', async () => {
  const controller = new AbortController();
  const pending = [];
  const office = officeFixture({ llm: { chat: () => new Promise(resolve => pending.push(resolve)) } });
  const canceled = assert.rejects(office.makeDocx({ topic: '取消', signal: controller.signal }), { name: 'AbortError' });
  const successful = office.makeDocx({ topic: '继续' });
  controller.abort();
  pending[0](docxResponse('取消'));
  pending[1](docxResponse('继续'));
  await canceled;
  const result = await successful;
  assert.ok(fs.readFileSync(result.file, 'utf8').startsWith('继续'));
});

test('cancel still terminates the local builder and cleans its spec', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const before = builds().length;
  const run = officeFixture().makeDocx({ topic: 'slow-build', signal: controller.signal });
  const canceled = assert.rejects(run, { name: 'AbortError' });
  try {
    for (let attempt = 0; attempt < 150 && builds().length === before; attempt++) await sleep(10);
  } finally {
    controller.abort();
  }
  await canceled;
  assert.equal(builds().length, before + 1, 'the fake builder must have started before cancellation');
  const row = builds().at(-1);
  assert.equal(row.title, 'slow-build');
  assert.equal(fs.existsSync(row.specPath), false);
  assert.equal(fs.existsSync(row.out), false);
});
