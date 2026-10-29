import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ADVERSARIAL_SCENARIOS as scenarios } from '../scripts/architecture-adversarial-cases.mjs';
import { assess, evaluateScenario, summarizeResults } from '../scripts/architecture-eval-core.mjs';
import { renderReport } from '../scripts/architecture-report.mjs';
import { CAPABILITIES } from '../src/agents/capabilities.js';
import { SPECS } from '../src/tools.js';

test('challenge set contains 40 independent scenarios, 48 turns and 8 balanced categories', () => {
  assert.equal(scenarios.length, 40);
  assert.equal(new Set(scenarios.map(s => s.id)).size, 40);
  assert.equal(scenarios.reduce((n, s) => n + s.turns.length, 0), 48);
  const categories = Object.groupBy(scenarios, s => s.category);
  assert.equal(Object.keys(categories).length, 8);
  assert.ok(Object.values(categories).every(v => v.length === 5));
  const names = new Set(Object.values(SPECS).map(s => s.function.name));
  for (const scenario of scenarios) for (const turn of scenario.turns) {
    assert.ok(turn.text.trim()); assert.ok(turn.input);
    for (const expected of turn.expected.alternatives || [turn.expected]) {
      assert.ok(['completed', 'clarification'].includes(expected.status));
      for (const op of [...(expected.ops || []), ...(expected.forbidden || [])]) assert.ok(CAPABILITIES[op], op);
      for (const name of [...expected.tools, ...(expected.optionalTools || [])]) assert.ok(names.has(name), name);
    }
  }
});

test('adversarial scoring catches invented durations, lost data, rewritten speech and duplicate tasks', () => {
  const expected = { status: 'completed', tools: ['send_voice'], absentSlots: ['seconds'], slotIncludes: { dataText: ['甲0元', '丙负20元'] }, toolArguments: { send_voice: { text: '你好！' } }, taskCount: 1 };
  const bad = { status: 'completed', intent: { slots: { seconds: 30, dataText: '甲10元、丙20元' } }, calls: [{ name: 'send_voice', args: { text: '你好' } }], steps: [], taskCount: 2 };
  const issues = assess(expected, bad);
  for (const fragment of ['不应推断参数', '丢失原文', '未保留确认值', '任务数应为']) assert.ok(issues.some(x => x.includes(fragment)));
  assert.deepEqual(assess(expected, { ...bad, intent: { slots: { dataText: '甲0元、丙负20元' } }, calls: [{ name: 'send_voice', args: { text: '你好！' } }], taskCount: 1 }), []);
});

test('score summary separates unrun scenarios and service errors from genuine failures', () => {
  const report = summarizeResults(scenarios, [
    { id: scenarios[0].id, status: 'pass', turns: [{ status: 'pass' }] },
    { id: scenarios[1].id, status: 'fail', turns: [{ status: 'fail' }] },
    { id: scenarios[2].id, status: 'error', turns: [{ status: 'error' }] },
  ]);
  assert.deepEqual(report.scenarios, { total: 40, attempted: 3, scored: 2, passed: 1, failed: 1, serviceErrors: 1, pending: 37, accuracy: 0.5 });
  assert.equal(report.turns.pending, 45);
  const empty = summarizeResults(scenarios, [], 3);
  assert.equal(empty.scenarios.total, 120); assert.equal(empty.turns.total, 144);
  assert.equal(empty.scenarios.accuracy, null); assert.equal(empty.scenarios.passed, 0);
});

test('model authentication failure stops multi-turn evaluation and does not leak provider errors', async () => {
  let calls = 0;
  const scenario = scenarios.find(s => s.id === 'turn-cancel-do-not-revive');
  const result = await evaluateScenario(scenario, { async chat() { calls++; throw Object.assign(new Error('provider echoed SECRET_VALUE'), { status: 401 }); } });
  assert.equal(result.status, 'error'); assert.equal(calls, 1); assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].serviceErrors[0].status, 401);
  assert.equal(JSON.stringify(result).includes('SECRET_VALUE'), false);
  assert.equal(summarizeResults([scenario], [result]).turns.pending, 2);
});

test('report preserves raw intent separately from execution repair and never prompts expected answers', async () => {
  const scenario = { id: 'punctuation', category: 'test', turns: [{ text: '用语音读：你好！', input: {}, expected: { status: 'completed', tools: ['send_voice'], slots: { text: '你好！' } } }] };
  const requests = [];
  const result = await evaluateScenario(scenario, { async chat(args) {
    requests.push(args);
    if (args.messages[0].content.includes('第一层多模态')) return { content: JSON.stringify({ act: 'create', targetId: '', kind: 'general', goal: '朗读', agents: ['audio'], operations: ['speech.synthesize'], forbiddenOperations: [], slots: { text: '你好' }, exclude: [], missing: [], clarification: '' }) };
    if (args.tools?.length && !args.messages.some(m => m.role === 'tool')) return { toolCalls: [{ id: 'v', function: { name: 'send_voice', arguments: '{"text":"错误"}' } }] };
    return { content: '已模拟执行' };
  } });
  assert.equal(result.status, 'pass');
  assert.equal(result.turns[0].actual.recognizedIntent.slots.text, '你好');
  assert.equal(result.turns[0].actual.intent.slots.text, '你好！');
  assert.equal(result.turns[0].actual.intentAttempts.length, 1);
  assert.equal(JSON.stringify(requests).includes('expected'), false);
  assert.equal(JSON.stringify(requests).includes('toolArguments'), false);
});

test('invalid model output counts as a model failure, not a service outage', async () => {
  const result = await evaluateScenario(scenarios[0], { async chat() { return { content: 'not JSON' }; } });
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.turns[0].serviceErrors, []);
  assert.deepEqual(result.turns[0].actual.intentAttempts, [{ invalid: true }, { invalid: true }]);
});

test('adversarial HTML embeds the exact pending dataset and has valid client JavaScript', () => {
  const report = { version: 1, suite: 'adversarial', engine: [], scenarios, live: { results: [], blockedReason: '缺少模型凭据' }, manual: [], summary: summarizeResults(scenarios, []) };
  const html = renderReport(report);
  const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.deepEqual(JSON.parse(embedded), report);
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(html.includes('--suite=adversarial'));
  assert.ok(html.includes('服务错误'));
  assert.equal(JSON.parse(embedded).summary.scenarios.accuracy, null);
});
