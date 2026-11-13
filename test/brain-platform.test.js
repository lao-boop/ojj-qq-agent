import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Resolve module-level data paths against fixtures, never the real QQ data.
const previousDataDir = process.env.QQBOT_DATA;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-brain-platform-'));
process.env.QQBOT_DATA = dataDir;
const { Brain } = await import('../src/brain.js');
const { createTools } = await import('../src/tools.js');
const { DEFAULTS } = await import('../src/config.js');

const qqPersona = 'QQ_PERSONA_FIXTURE';
const globalFile = path.join(dataDir, 'memory-global.json');
const globalFixture = JSON.stringify({
  bot: { name: 'QQ_BOT_FIXTURE', alias: 'QQ_ALIAS_FIXTURE' },
  owner: { name: 'QQ_OWNER_FIXTURE', aliases: [], likes: [] },
  facts: ['QQ_GLOBAL_FACT_FIXTURE'],
});
fs.writeFileSync(path.join(dataDir, 'persona.md'), qqPersona);
fs.writeFileSync(globalFile, globalFixture);

after(() => {
  if (previousDataDir === undefined) delete process.env.QQBOT_DATA;
  else process.env.QQBOT_DATA = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, debug() {} };
const meta = { scene: '企业微信私聊', peerName: '测试成员' };

function brainFixture(overrides = {}) {
  const appended = [];
  const memory = {
    context: () => ({ summary: '', notes: [], turns: [], recalled: [] }),
    append: (...args) => appended.push(args),
    maybeSummarize: async () => false,
  };
  const brain = new Brain({
    cfg: { maxBubbles: 3 },
    llm: { chat: async () => ({ content: '收到。', toolCalls: [] }) },
    memory,
    tools: { specs: [], imageEnabled: false },
    logger,
    ...overrides,
  });
  return { brain, appended };
}

test('QQ defaults retain persona, public memory and reply instructions', () => {
  const { brain } = brainFixture();
  const system = brain.buildSystem({ chat: 'private:123', meta: { scene: '私聊' }, ctxText: '会话笔记' });
  assert.equal(brain.persona(), qqPersona);
  assert.ok(system.includes('QQ_OWNER_FIXTURE'));
  assert.ok(system.includes('QQ_GLOBAL_FACT_FIXTURE'));
  assert.ok(system.includes('不要写「小鲸鱼：」这样的前缀'));
  assert.ok(system.includes('一条回复控制在 1~3 条短消息'));
  assert.ok(system.includes('会话笔记'));
});

test('platform providers replace QQ identity, global memory and reply rules', () => {
  let persona = '企业知识助手';
  const { brain } = brainFixture({
    personaProvider: () => persona,
    globalContext: () => '',
    selfState: () => '',
    replyInstructions: ['只说明当前渠道实际支持的能力。', '回答工作问题。'],
  });
  const system = brain.buildSystem({ chat: 'wecom:corp:private:123', meta });
  assert.ok(system.includes('企业知识助手'));
  assert.ok(system.includes('企业微信私聊'));
  assert.ok(system.includes('回答工作问题。'));
  assert.doesNotMatch(system, /QQ_|主人|私人使用|小鲸鱼：/);
  persona = '';
  assert.equal(brain.persona(), '', 'an empty platform persona must not reveal the QQ persona');
});

test('platform context and string reply instructions are injectable', () => {
  const { brain } = brainFixture({
    personaProvider: () => '企业助手',
    globalContext: () => '企业公开资料',
    replyInstructions: '给出简短、准确的回答。',
  });
  const system = brain.buildSystem({ chat: 'wecom:corp:private:member', meta });
  assert.ok(system.includes('企业公开资料'));
  assert.ok(system.includes('给出简短、准确的回答。'));
  assert.doesNotMatch(system, /QQ_OWNER_FIXTURE|QQ_GLOBAL_FACT_FIXTURE/);
});

test('default responses still persist both conversation turns', async () => {
  const { brain, appended } = brainFixture();
  const result = await brain.respond({ chatKey: 'private:123', title: 'QQ 测试', userText: '你好', meta });
  assert.deepEqual(appended, [
    ['private:123', 'user', '你好', 'QQ 测试'],
    ['private:123', 'assistant', result.bubbles.join('\n'), 'QQ 测试'],
  ]);
});

test('persistAssistant=false records the user while leaving delivery persistence to the runtime', async () => {
  const { brain, appended } = brainFixture();
  const result = await brain.respond({
    chatKey: 'wecom:corp:private:member', title: '企业测试', userText: '你好', meta,
    persistAssistant: false,
  });
  assert.deepEqual(result.bubbles, ['收到。']);
  assert.deepEqual(appended, [['wecom:corp:private:member', 'user', '你好', '企业测试']]);
});

function toolFixture(allowedTools) {
  const effects = [];
  const cfg = structuredClone(DEFAULTS);
  cfg.image.enabled = true;
  cfg.tts.enabled = true;
  cfg.access.ownerQQ = '123';
  const tools = createTools({
    cfg,
    logger,
    allowedTools,
    qzone: {
      enabled: true,
      makeImage: async () => { effects.push('qzone.image'); return ''; },
      post: async () => effects.push('qzone.post'),
    },
    minecraft: { online: true, say: () => effects.push('mc.say') },
    tts: { synthesize: async () => { effects.push('tts'); return { voice: 'test-voice' }; } },
    friendNotify: async () => effects.push('friendNotify'),
  });
  const ctx = {
    // Even a valid QQ owner identity must not bypass platform restrictions.
    chatKey: 'private:123', peerName: '主人', images: [], voices: [], songs: [], documents: [], videos: [],
    memory: { addNote: () => { effects.push('remember'); return true; } },
  };
  return { tools, effects, ctx };
}

test('allowedTools filters schemas and blocks hidden tools before side effects', async () => {
  const { tools, effects, ctx } = toolFixture(['get_time', 'remember', 'not_a_tool']);
  assert.deepEqual(tools.specs.map(s => s.function.name).sort(), ['get_time', 'remember']);
  assert.equal(tools.imageEnabled, false);
  assert.equal(tools.ttsEnabled, false);
  assert.deepEqual(tools.stickerCats, []);
  for (const name of ['post_qzone', 'mc_say', 'remember_global', 'relay_to_friend', 'send_voice', 'not_a_tool']) {
    assert.match(await tools.run(name, { text: '测试', content: '测试' }, ctx), /不可用/);
  }
  assert.deepEqual(effects, []);
  assert.equal(fs.readFileSync(globalFile, 'utf8'), globalFixture);
  assert.match(await tools.run('remember', { text: '企业会话笔记' }, ctx), /记住了/);
  assert.deepEqual(effects, ['remember']);
});

test('an empty allowedTools list disables every tool', async () => {
  const { tools, effects, ctx } = toolFixture([]);
  assert.deepEqual(tools.specs, []);
  assert.match(await tools.run('remember', { text: '测试' }, ctx), /不可用/);
  assert.deepEqual(effects, []);
  assert.throws(() => toolFixture('get_time'), /allowedTools must be an array/);
});

test('omitting allowedTools preserves the QQ tool registry and execution', async () => {
  const { tools, effects, ctx } = toolFixture();
  const names = tools.specs.map(s => s.function.name);
  assert.ok(names.includes('post_qzone'));
  assert.ok(names.includes('relay_to_friend'));
  assert.ok(names.includes('mc_say'));
  assert.equal(tools.imageEnabled, true);
  assert.equal(tools.ttsEnabled, true);
  assert.match(await tools.run('send_voice', { text: '你好' }, ctx), /已用语音发出（音色 test-voice）/);
  assert.deepEqual(effects, ['tts']);
  assert.equal(ctx.voices.length, 1);
  assert.equal(await tools.run('not_a_tool', {}, ctx), '未知工具：not_a_tool');
});

test('the brain cannot execute an unadvertised platform tool returned by the model', async () => {
  const { tools, effects } = toolFixture(['get_time']);
  let calls = 0;
  const { brain } = brainFixture({
    tools,
    llm: {
      async chat({ messages, tools: advertised }) {
        assert.deepEqual(advertised.map(s => s.function.name), ['get_time']);
        if (calls++ === 0) return {
          content: '',
          toolCalls: [{ id: 'unavailable-call', function: { name: 'post_qzone', arguments: '{"content":"测试"}' } }],
        };
        assert.match(messages.at(-1).content, /不可用/);
        return { content: '当前渠道不支持发 QQ 空间。', toolCalls: [] };
      },
    },
    personaProvider: () => '企业助手',
    globalContext: () => '',
    replyInstructions: ['仅使用当前渠道工具。'],
  });
  await brain.respond({ chatKey: 'wecom:corp:private:member', userText: '发布一条动态', meta });
  assert.equal(calls, 2);
  assert.deepEqual(effects, []);
});
