import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS } from '../scripts/architecture-cases.mjs';
import { assess, evaluateScenario, sandboxTools } from '../scripts/architecture-eval-core.mjs';
import { renderReport } from '../scripts/architecture-report.mjs';

const structured = patch => ({ act: 'create', targetId: '', kind: 'general', goal: '制作PPT', agents: ['document'], operations: ['document.create'], forbiddenOperations: [], slots: { format: 'ppt', topic: '露营计划', pages: 8 }, exclude: [], missing: [], clarification: '', ...patch });

test('evaluation detects wrong and extra tools, parameter loss and missing dependencies', () => {
  const expected = { status: 'completed', ops: ['document.create'], tools: ['make_ppt'], slots: { pages: 8 }, forbidden: ['image.generate'] };
  const actual = { status: 'completed', taskStatus: 'completed', calls: [{ name: 'draw_image' }], intent: { operations: ['image.generate'], slots: { pages: 6 }, forbiddenOperations: [] }, steps: [] };
  const issues = assess(expected, actual).join('\n');
  for (const fragment of ['漏调工具', '不应调用', '缺少操作', '多出操作', '参数 pages', '未保留禁止项', '排队状态']) assert.ok(issues.includes(fragment));
  assert.ok(assess({ ...expected, dependency: ['research', 'document'] }, actual).some(x => x.includes('缺少依赖')));
});

test('live evaluation path drives production Manager and pins tool arguments without generating files', async () => {
  const scenario = SCENARIOS.find(s => s.id === 'ppt');
  const requests = [];
  const llm = { async chat(args) {
    requests.push(args);
    if (String(args.messages[0].content).includes('第一层多模态')) return { content: JSON.stringify(structured({})) };
    if (args.tools?.some(s => s.function.name === 'make_ppt') && !args.messages.some(m => m.role === 'tool')) return { content: '', toolCalls: [{ id: 'ppt-test', type: 'function', function: { name: 'make_ppt', arguments: JSON.stringify({ topic: 'wrong', pages: 5 }) } }] };
    return { content: '模拟任务已排队，尚未交付。' };
  } };
  const result = await evaluateScenario(scenario, llm);
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.turns[0].actual.calls[0].args.pages, 8);
  assert.equal(result.turns[0].actual.taskStatus, 'queued');
  assert.ok(requests.length >= 3);
  assert.equal(JSON.stringify(requests).includes('expected'), false, 'expected answers must never enter model prompts');
});

test('multi-turn cancellation checks actual task state and sends no tools', async () => {
  let count = 0;
  const result = await evaluateScenario(SCENARIOS.find(s => s.id === 'cancel'), { async chat(args) {
    const input = JSON.parse(args.messages[1].content);
    return { content: JSON.stringify(count++ === 0 ? structured({ slots: { format: 'ppt' } }) : structured({ act: 'cancel', targetId: input.tasks[0].id, slots: {}, operations: [] })) };
  } });
  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.turns[1].actual.taskStatus, 'cancelled');
  assert.equal(result.turns.flatMap(t => t.actual.calls).length, 0);
});

test('sandbox never instantiates real media or messaging tools; side effects remain fixture arrays', async () => {
  const calls = [], tools = sandboxTools(calls), ctx = { documents: [], images: [], voices: [], songs: [] };
  for (const name of ['draw_image', 'send_voice', 'remember_global', 'relay_to_friend', 'post_qzone']) await tools.run(name, { text: 'fixture' }, ctx);
  assert.equal(calls.length, 5);
  assert.equal(ctx.images[0].file, 'simulation-only.png');
  assert.equal(ctx.voices[0].file, 'simulation-only.mp3');
});

test('HTML report escapes embedded script delimiters and labels unrun model cases', () => {
  const report = { version: 1, engine: [], live: { results: [] }, scenarios: [], manual: [], text: '</script><script>alert("unsafe")</script>' };
  const html = renderReport(report);
  assert.equal(html.includes(report.text), false);
  const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.deepEqual(JSON.parse(embedded), report);
  assert.ok(html.includes('真实模型尚未实测'));
});
