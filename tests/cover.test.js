import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { coverConfigurationIssue, coverCapabilityReply } from '../src/cover-config.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';
import { normalizeInput } from '../src/agents/intent.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-test-'));
process.env.QQBOT_DATA = tmp;
const { VoiceConvert } = await import('../src/cover.js');
const { OneBot } = await import('../src/onebot.js');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const logger = { info() {}, warn() {} };
const cfg = { enabled: true, token: 'fake-token', rvcModel: 'Preset', model: 'owner/test', version: 'fixed-version' };

test('QQ voice upload gets a longer response budget without retrying', async () => {
  const bot = new OneBot({ wsUrl: 'ws://localhost', logger });
  const calls = []; bot.call = async (...args) => calls.push(args);
  await bot.sendPrivate(10001, [{ type: 'record', data: { file: 'base64://test' } }]);
  await bot.sendGroup(90001, [{ type: 'record', data: { file: 'base64://test' } }]);
  await bot.sendPrivate(10001, [{ type: 'text', data: { text: 'test' } }]);
  await bot.sendPrivate(10001, 'plain text');
  assert.deepEqual(calls.map(c => c[2]), [120000, 120000, 20000, 20000]);
});

test('cover readiness validates switch, provider credentials and custom voice before upload', () => {
  assert.match(coverConfigurationIssue({}), /开关/);
  assert.match(coverConfigurationIssue({ enabled: true, token: 'YOUR_REPLICATE_TOKEN' }), /token/);
  assert.match(coverConfigurationIssue({ ...cfg, rvcModel: 'CUSTOM' }), /下载地址/);
  assert.equal(coverConfigurationIssue(cfg), '');
  assert.match(coverCapabilityReply('你会不会唱歌', { enabled: false }), /还不能执行/);
  assert.equal(coverCapabilityReply('翻唱我下一条语音', cfg), '');
});

for (const status of ['succeeded', 'failed', 'invalid-output']) test(`RVC ${status}: pinned schema, exact source and no duplicate predictions`, async t => {
  const requests = [];
  let base;
  const server = http.createServer(async (req, res) => {
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const body = Buffer.concat(buffers);
    requests.push({ url: req.url, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/files') return res.end(JSON.stringify({ urls: { get: `${base}/source` } }));
    if (req.url === '/predictions') return res.end(JSON.stringify({ id: `test-${status}`, status: status === 'failed' ? 'failed' : 'succeeded', output: `${base}/result`, error: 'conversion failed' }));
    if (req.url === '/result') {
      res.setHeader('Content-Type', status === 'invalid-output' ? 'text/html' : 'audio/mpeg');
      return res.end(Buffer.alloc(1400, 42));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const converter = new VoiceConvert({ ...cfg, apiBase: base }, logger);
  const source = path.join(tmp, `${status}-source.mp3`); fs.writeFileSync(source, 'source-audio-marker');
  if (status === 'succeeded') {
    const result = await converter.convert({ audioPath: source });
    assert.equal(fs.statSync(result.file).size, 1400);
  } else await assert.rejects(converter.convert({ audioPath: source }), status === 'failed' ? /conversion failed/ : /不是有效音频/);
  assert.equal(requests.filter(r => r.url === '/predictions').length, 1);
  assert.equal(requests.filter(r => r.url.startsWith('/models')).length, 0);
  const submitted = JSON.parse(requests.find(r => r.url === '/predictions').body);
  assert.equal(submitted.version, 'fixed-version');
  assert.equal(submitted.input.rvc_model, 'Preset');
  assert.equal(submitted.input.song_input, `${base}/source`);
  assert.ok(requests.find(r => r.url === '/files').body.includes('source-audio-marker'));
});

const intent = patch => ({ act: 'create', targetId: '', kind: 'cover', goal: '翻唱下一条音频', agents: ['audio'], operations: ['cover.perform'], forbiddenOperations: [], slots: { source: 'next_audio' }, exclude: [], missing: [], clarification: '', ...patch });
function pipeline(outputs) {
  return new UnderstandingPipeline({ llm: { chat: async () => ({ content: JSON.stringify(outputs.shift()) }) }, validators: { cover: async i => ({ value: { source: i.slots.source } }) } });
}
const input = (text, actorId = 'owner', audio = false) => normalizeInput({ userText: text, actorId, attachments: { audios: audio ? [{ name: 'voice.silk' }] : [] } });

test('spoken prepare instruction with audio attached waits; only next task update becomes executable', async () => {
  const p = pipeline([intent({}), intent({ act: 'update', slots: { source: 'attachment' } })]);
  const waiting = await p.prepare('private:1', input('准备，翻唱我下一条语音', 'owner', true));
  assert.match(waiting.reply, /等待下一条/);
  assert.equal(waiting.task.status, 'draft');
  assert.equal(waiting.intent, undefined);
  const ready = await p.prepare('private:1', input('这才是要翻唱的音频', 'owner', true));
  assert.equal(ready.task.id, waiting.task.id);
  assert.equal(ready.intent.slots.source, 'attachment');
});

test('waiting cover can be cancelled, expires, and cannot be claimed by another group member', async () => {
  const p = pipeline([intent({}), intent({ act: 'update', slots: { source: 'attachment' } }), intent({ act: 'cancel', slots: {} })]);
  const waiting = await p.prepare('group:1', input('下一条翻唱'));
  assert.match((await p.prepare('group:1', input('我的音频', 'other', true))).reply, /另一位/);
  assert.match((await p.prepare('group:1', input('取消翻唱'))).reply, /取消/);
  assert.equal(waiting.task.status, 'cancelled');
  const expired = pipeline([intent({}), intent({ act: 'update', slots: { source: 'attachment' } })]);
  const task = (await expired.prepare('private:2', input('下一条翻唱'))).task;
  task.updatedAt -= 11 * 60 * 1000;
  assert.match((await expired.prepare('private:2', input('音频', 'owner', true))).reply, /过期/);
});
