import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { SCENARIOS, MANUAL_CASES } from './architecture-cases.mjs';
import { renderReport } from './architecture-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), value = (key, fallback) => args.find(a => a.startsWith(`${key}=`))?.slice(key.length + 1) || fallback;
if (args.includes('--help')) {
  console.log('node scripts/evaluate_architecture.mjs [--live] [--case=ID] [--limit=N] [--repeat=N] [--out=reports/architecture-live.html]\n默认运行本地自动测试，不联网。--live 额外使用本地 llm 配置调用模型（收费），所有工具模拟运行，不发送QQ、不生成收费媒体、不写真实记忆。');
  process.exit(0);
}
const live = args.includes('--live'), out = path.resolve(ROOT, value('--out', live ? 'reports/architecture-live.html' : 'reports/architecture-report.html'));
const positive = (key, fallback, max) => { const n = Number(value(key, fallback)); if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${key} 必须为1～${max}的整数`); return n; };
const limit = positive('--limit', SCENARIOS.length, SCENARIOS.length), repeat = positive('--repeat', 1, 5);
let selected = value('--case', '') ? SCENARIOS.filter(s => s.id === value('--case', '')) : SCENARIOS.slice(0, limit);
if (!selected.length) throw new Error('未找到对应测试用例');
let llm;
if (live) {
  const { CONFIG_PATH, DEFAULTS, deepMerge } = await import('../src/config.js');
  if (!fs.existsSync(CONFIG_PATH)) throw new Error('没有本机 config.json；请在已配置 DeepSeek 的 Mac 项目目录运行 --live。');
  const cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  if (!cfg.llm.apiKey || cfg.llm.apiKey.startsWith('YOUR_')) throw new Error('请先在本机配置 llm.apiKey；不要把密钥发到聊天里。');
  const { LLM } = await import('../src/llm.js');
  llm = new LLM(cfg.llm, { debug() {}, warn: s => console.log(`[模型] ${s}`) });
}
const started = Date.now();
let revision = 'unknown', dirty = true;
try { revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim()); } catch {}
const tests = [], files = fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.js')).sort();
console.log(`运行 ${files.length} 个自动测试文件；无真实QQ发送或收费媒体生成。`);
for (const file of files) {
  const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', path.join('tests', file)], { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const output = child.stdout || '';
  const matches = [...output.matchAll(/^(not ok|ok) (\d+) - (.+)\r?\n([\s\S]*?)(?=^(?:not ok|ok) \d+ - |^# Subtest:|^1\.\.|$(?![\s\S]))/gm)];
  for (const m of matches) tests.push({ file, name: m[3], status: /# (SKIP|TODO)/.test(m[3]) ? 'skip' : m[1] === 'ok' ? 'pass' : 'fail', ms: Number(/duration_ms: ([\d.]+)/.exec(m[4])?.[1] || 0), detail: m[1] === 'ok' ? '' : m[4].slice(0, 6000) });
  const count = Number(/^# tests (\d+)/m.exec(output)?.[1]);
  if (Number.isFinite(count) && count !== matches.length) tests.push({ file, name: '报告解析结果数量不符', status: 'fail', ms: 0, detail: `TAP声明${count}个测试，解析得到${matches.length}个；不得把遗漏的测试当作通过。` });
  if (!matches.length || (child.status !== 0 && !matches.some(m => m[1] === 'not ok'))) tests.push({ file, name: '测试进程异常或没有结果', status: 'fail', ms: 0, detail: child.error?.code || `exit=${child.status}; ${String(child.stderr || '').slice(0, 1500)}` });
  console.log(`${file}: ${child.status === 0 ? '完成' : '失败'}`);
}
const report = { version: 1, rubric: 'routing-v2', generatedAt: new Date().toISOString(), revision, dirty, node: process.version, engine: tests, live: { requested: live, model: llm?.cfg.model || '', results: [], selected: live ? selected.map(s => s.id) : [], repeat, completed: false }, scenarios: SCENARIOS, manual: MANUAL_CASES, ms: 0 };
function save() {
  report.ms = Date.now() - started; report.generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderReport(report));
  fs.writeFileSync(out.replace(/\.html$/i, '') + '.json', JSON.stringify(report, null, 2));
}
save();
if (live) {
  console.log(`真实模型：${llm.cfg.model}；${selected.length} 个场景 × ${repeat} 次。只有文本API收费；工具全部模拟。每个场景结束自动保存。`);
  const { evaluateScenario } = await import('./architecture-eval-core.mjs');
  for (let round = 1; round <= repeat; round++) for (const scenario of selected) {
    console.log(`[${round}/${repeat}] ${scenario.id} ${scenario.category}`);
    const result = await evaluateScenario(scenario, llm);
    report.live.results.push({ ...result, round }); save();
    console.log(`  ${result.status} / ${Math.round(result.ms / 1000)}秒`);
  }
  report.live.completed = true;
  report.live.usage = { ...llm.stats }; save();
}
console.log(`HTML：${out}\nJSON：${out.replace(/\.html$/i, '')}.json`);
if (tests.some(t => t.status === 'fail') || report.live.results.some(r => r.status === 'fail')) process.exitCode = 1;
