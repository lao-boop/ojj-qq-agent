import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ImageGen } from '../src/image.js';
import { createTools } from '../src/tools.js';

const log = { info() {}, warn() {}, debug() {}, error() {} };
const config = {
  provider: 'replicate', enabled: true, maxPromptChars: 400, defaultSize: 'square',
  model: 'black-forest-labs/flux-2-pro', repairModel: 'google/nano-banana-2',
  reviewModel: 'google/gemini-3-flash', apiKey: 'fixture',
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGEkAAAAASUVORK5CYII=', 'base64');

function predictions(t, reviews) {
  const draws = [], checks = [], downloads = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://fixture.invalid/')) {
      downloads.push(url);
      return new Response(png);
    }
    assert.equal(options.method, 'POST');
    const input = JSON.parse(options.body).input;
    let output;
    if (url.includes(config.reviewModel)) {
      checks.push(input);
      assert.ok(reviews.length, 'unexpected review');
      output = reviews.shift();
    } else {
      draws.push({ url, input });
      output = 'https://fixture.invalid/' + draws.length;
    }
    return Response.json({ status: 'succeeded', output });
  });
  return { draws, checks, downloads };
}

test('chat keeps the original request, full translated brief and best repair reference', async t => {
  const request = '横版 PNG：戴黄色围巾的蓝鲸在左，右上角是红日，画上写“早安”。';
  const brief = 'Flat illustration. '.repeat(25) + 'Keep the red sun at the upper right. Show the lettering 早安.';
  const verdict = (...fixes) => JSON.stringify({ pass: fixes.length === 0, fixes, scarf_attachment: fixes.length ? 'misplaced' : 'neck_wrap', contour_color: null });
  const { draws, checks, downloads } = predictions(t, [
    'incomplete JSON', '{"pass":true,"fixes":[],"scarf_attachment":"misplaced","contour_color":null}',
    verdict('Put the scarf around the neck', 'Restore the sun'),
    verdict('Move the scarf'), verdict(),
  ]);
  const imageGen = new ImageGen(config, log);
  imageGen.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-repair-test-'));
  t.after(() => {
    for (const file of fs.readdirSync(imageGen.dir)) fs.unlinkSync(path.join(imageGen.dir, file));
    fs.rmdirSync(imageGen.dir);
  });
  const llm = { cfg: {}, chat: async () => ({ content: brief }) };
  const tools = createTools({ cfg: { image: config }, llm, imageGen, logger: log });
  const ctx = { chatKey: 'fixture', images: [] };
  await tools.run('draw_image', { prompt: request }, ctx);
  assert.equal(ctx.images.length, 1);
  assert.equal(ctx.images[0].reviewed, true);
  assert.deepEqual(fs.readFileSync(ctx.images[0].file), png);
  assert.ok(draws[0].input.prompt.includes(brief));
  assert.equal(draws[0].input.aspect_ratio, '16:9');
  assert.equal(draws[0].input.output_format, 'png');
  assert.ok(checks.every(check => check.prompt === request));
  assert.deepEqual(checks[0].images, checks[1].images);
  assert.deepEqual(draws[1].input.image_input, ['https://fixture.invalid/1']);
  assert.deepEqual(draws[2].input.image_input, ['https://fixture.invalid/1']);
  assert.ok(draws[3].url.includes(config.model));
  assert.equal(draws[3].input.image_input, undefined);
  assert.deepEqual(downloads, ['https://fixture.invalid/4']);
});

test('eight failed reviews exhaust one job and never deliver a rejected image', async t => {
  const { draws, downloads } = predictions(t, Array(8).fill('{"pass":false,"fixes":["Restore the requested color"]}'));
  const imageGen = new ImageGen(config, log);
  await assert.rejects(imageGen.generate({ prompt: 'a red tulip', seed: 42 }), { qualityRejected: true });
  assert.equal(draws.length, 8);
  assert.deepEqual(draws.map(draw => draw.input.seed), [42,43,44,45,46,47,48,49]);
  assert.deepEqual(downloads, []);
});

test('invalid review replies retry verification on the same image and stop', async t => {
  const { draws, checks, downloads } = predictions(t, ['not JSON', '{"pass":true,"fixes":["incorrect placement"]}']);
  await assert.rejects(new ImageGen(config, log).generate({ prompt: 'a red tulip' }), /核验服务/);
  assert.equal(draws.length, 1);
  assert.equal(checks.length, 2);
  assert.deepEqual(downloads, []);
});

test('chat checks the replacement before attaching it on backends without built-in review', async () => {
  const file = new URL('../assets/sample-image.jpg', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  let draws = 0, reviews = 0;
  const imageGen = { generate: async () => {
    draws++;
    return { file: fileURLToPath(file) };
  } };
  const llm = { cfg: {}, chat: async () => {
    reviews++;
    return { content: '{"bad":true,"issue":"Wrong background color"}' };
  } };
  const tools = createTools({ cfg: { image: { ...config, provider: 'mock' } }, llm, imageGen, logger: log });
  const ctx = { chatKey: 'fixture', images: [] };
  const result = await tools.run('draw_image', { prompt: 'tulip on blue' }, ctx);
  assert.match(result, /补画后仍未通过/);
  assert.equal(draws, 2);
  assert.equal(reviews, 2);
  assert.deepEqual(ctx.images, []);
});
