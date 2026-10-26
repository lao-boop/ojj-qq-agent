import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multimodal-'));
process.env.QQBOT_DATA = tmp;
const { TTS } = await import('../src/tts.js');
const { VisionClient } = await import('../src/vision.js');
const { Brain } = await import('../src/brain.js');
const { FileReader } = await import('../src/files.js');
const { ConsoleServer } = await import('../src/server.js');
const { normalizeInput } = await import('../src/agents/intent.js');
const { ReplySender } = await import('../src/reply.js');
const { localAsrStatus, localAsrHealthy } = await import('../src/asr-local.js');
const { silkToWav } = await import('../src/media.js');
const logger = { info() {}, warn() {}, debug() {}, error() {}, child() { return this; } };
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('long voice text is rejected before contacting MiniMax; QQ delivery failure propagates', async () => {
  const tts = new TTS({ enabled: true, provider: 'minimax', maxChars: 3, minimax: {} }, logger);
  await assert.rejects(tts.synthesize('不能截断这句话'), /未截断/);
  const voiceFile = path.join(tmp, 'send.mp3'); fs.writeFileSync(voiceFile, 'audio');
  const sender = new ReplySender({ cfg: { firstDelayMs: [0, 0], splitDelayMs: [0, 0] }, logger, onebot: { sendPrivate: async () => { throw new Error('QQ rejected record'); } } });
  await assert.rejects(sender.send({ type: 'private', userId: 10001, key: 'private:10001' }, { voices: [{ file: voiceFile }] }), /QQ rejected record/);
});

async function server(t, respond) {
  const requests = [];
  const srv = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const data = respond(requests.at(-1), res);
    if (!res.writableEnded) res.end(JSON.stringify(data));
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => srv.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${srv.address().port}`, requests };
}

test('ASR status reports actual loaded model, not requested config', async t => {
  const api = await server(t, () => ({ ok: true, model: 'small' }));
  assert.deepEqual(await localAsrStatus(api.baseUrl), { ok: true, model: 'small' });
  assert.equal(await localAsrHealthy(api.baseUrl), true);
});

test('SILK decoder error retains final exception instead of truncating at traceback header', async () => {
  const fake = path.join(tmp, 'decoder');
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "Traceback: ' + 'frame '.repeat(80) + '" "DecoderError: invalid SILK header" >&2\nexit 1\n', { mode: 0o700 });
  const input = path.join(tmp, 'invalid.silk'); fs.writeFileSync(input, 'bad input');
  await assert.rejects(silkToWav(input, { python: fake }), /DecoderError: invalid SILK header/);
});

test('MiniMax emits exact MP3 bytes and sends configured voice/model, not Edge TTS options', async t => {
  const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1400, 42)]);
  const api = await server(t, () => ({ base_resp: { status_code: 0 }, data: { audio: bytes.toString('hex'), status: 2 } }));
  const tts = new TTS({ enabled: true, provider: 'minimax', minimax: { ...api, apiKey: 'test-credential', model: 'speech-test', voiceId: 'test-voice' } }, logger);
  const result = await tts.synthesize('下午三点开会');
  assert.deepEqual(fs.readFileSync(result.file), bytes);
  assert.equal(api.requests[0].url, '/v1/t2a_v2');
  assert.equal(api.requests[0].headers.authorization, 'Bearer test-credential');
  assert.equal(api.requests[0].body.voice_setting.voice_id, 'test-voice');
  assert.equal(api.requests[0].body.text, '下午三点开会');
  assert.equal(api.requests[0].body.output_format, 'hex');
  assert.equal(api.requests[0].body.audio_setting.format, 'mp3');
  assert.equal(result.voice, 'test-voice');
});

for (const failure of ['http', 'business', 'invalid-audio', 'missing-code']) test(`MiniMax ${failure} failure produces no artifact and no paid retry`, async t => {
  const before = fs.readdirSync(path.join(tmp, 'audio'));
  const api = await server(t, (_req, res) => {
    if (failure === 'http') { res.statusCode = 401; return { secret: 'must-not-appear' }; }
    return { ...(failure === 'missing-code' ? {} : { base_resp: { status_code: failure === 'business' ? 1008 : 0 } }), data: { audio: 'https://untrusted.invalid/audio' } };
  });
  const tts = new TTS({ enabled: true, provider: 'minimax', minimax: { ...api, apiKey: 'secret', model: 'x', voiceId: 'y' } }, logger);
  await assert.rejects(tts.synthesize('测试'), err => !/secret|must-not-appear/.test(err.message));
  assert.equal(api.requests.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'audio')), before);
});

test('vision routes image and credentials exclusively to its independent API', async t => {
  const api = await server(t, () => ({ choices: [{ message: { content: '金额为 123 元' } }] }));
  const legacy = await server(t, () => { throw new Error('must not contact text provider'); });
  const vision = new VisionClient({ enabled: true, baseUrl: api.baseUrl, apiKey: 'vision-secret', model: 'visual-test' }, { baseUrl: legacy.baseUrl, apiKey: 'text-secret' }, logger);
  const brain = new Brain({ cfg: {}, vision, logger, llm: { chat() { throw new Error('must not use text LLM'); } } });
  const caption = await brain.describeImages([{ file: path.resolve('assets/sample-image.jpg') }], '读出金额');
  assert.match(caption, /123/);
  assert.equal(api.requests[0].body.model, 'visual-test');
  assert.equal(api.requests[0].headers.authorization, 'Bearer vision-secret');
  assert.match(api.requests[0].body.messages[0].content[1].image_url.url, /^data:image/);
  assert.equal(legacy.requests.length, 0);
});

test('vision failure cannot become valid image evidence or leak reasoning; disabled sends nothing', async t => {
  const api = await server(t, () => ({ choices: [{ message: { content: '', reasoning_content: 'invented image contents' } }] }));
  const vision = new VisionClient({ enabled: true, baseUrl: api.baseUrl, apiKey: 'test', model: 'v' }, {}, logger);
  const brain = new Brain({ cfg: {}, vision, logger, llm: {} });
  const images = [{ file: path.resolve('assets/sample-image.jpg') }];
  let caption = await brain.describeImages(images);
  assert.doesNotMatch(caption, /invented/);
  assert.equal(normalizeInput({ images, caption }).imageReadFailed, true);
  vision.updateConfig({ enabled: false }, {});
  caption = await brain.describeImages(images);
  assert.match(caption, /识别未成功/);
  assert.equal(api.requests.length, 1);
});

test('Docker path mapping reads shared bytes and blocks traversal and symlink escape', async () => {
  const shared = path.join(tmp, 'shared'); fs.mkdirSync(shared);
  const file = path.join(shared, 'report.txt'); fs.writeFileSync(file, '项目进度 80%');
  const reader = new FileReader({ cfg: { pathMappings: [{ remote: '/app/.config/QQ', local: shared }] }, logger });
  const download = await reader.download({ call: async () => ({ file: '/app/.config/QQ/report.txt' }) }, { file_id: 'abc', name: 'report.txt' });
  assert.equal(fs.readFileSync(download.path, 'utf8'), '项目进度 80%');
  assert.equal(reader.resolveLocal('/app/.config/QQ/../outside.txt'), '');
  const outside = path.join(tmp, 'outside.txt'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(shared, 'link'));
  assert.equal(reader.resolveLocal('/app/.config/QQ/link'), '');
  assert.equal(reader.resolveLocal('/app/.config/QQ-other/report.txt'), '');
});

test('get_file URL remains usable when its container file path is inaccessible', async t => {
  const api = await server(t, (_req, res) => { res.end('file-content'); });
  const reader = new FileReader({ cfg: {}, logger });
  const file = await reader.download({ call: async () => ({ file: '/missing/container/file', url: api.baseUrl }) }, { file_id: 'id', name: 'memo.txt' });
  assert.equal(fs.readFileSync(file.path, 'utf8'), 'file-content');
});

test('console masks all new and existing provider credentials', async t => {
  const cfg = { console: { enabled: true, host: '127.0.0.1', port: 0, token: 'console-test' }, vision: { apiKey: 'vision-test-secret' }, tts: { minimax: { apiKey: 'minimax-test-secret' } }, asr: { token: 'asr-test-secret' }, voice: { token: 'voice-test-secret' } };
  const server = new ConsoleServer({ cfg, logger, hooks: {} });
  server.start();
  await new Promise(resolve => server.server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${server.server.address().port}/api/config`, { headers: { 'x-console-token': 'console-test' } });
  const text = await res.text();
  for (const value of ['vision-test-secret', 'minimax-test-secret', 'asr-test-secret', 'voice-test-secret']) assert.ok(!text.includes(value));
  assert.match(text, /••••/);
});
