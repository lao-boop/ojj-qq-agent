import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SCENARIOS, MANUAL_CASES } from './architecture-cases.mjs';
import { ADVERSARIAL_SCENARIOS } from './architecture-adversarial-cases.mjs';
import { summarizeResults } from './architecture-eval-core.mjs';
import { renderReport } from './architecture-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), value = (key, fallback) => args.find(a => a.startsWith(`${key}=`))?.slice(key.length + 1) || fallback;
if (args.includes('--help')) {
  console.log('node scripts/evaluate_architecture.mjs [--suite=standard|adversarial] [--live] [--model=NAME] [--case=ID] [--limit=N] [--repeat=N] [--concurrency=N] [--out=reports/architecture-live.html]\n默认运行本地自动测试，不联网。--live 使用本地 llm 配置或安全注入的 DEEPSEEK_API_KEY 调用模型（收费）；可用 LLM_BASE_URL 覆盖地址。所有工具模拟运行，不发送QQ、不生成收费媒体、不写真实记忆。缺凭据也会保存未运行报告，并以非零状态退出。');
  process.exit(0);
}
const suite = value('--suite', 'standard');
if (!['standard', 'adversarial'].includes(suite)) throw new Error('未知题库；请选择 standard 或 adversarial');
const scenarios = suite === 'adversarial' ? ADVERSARIAL_SCENARIOS : SCENARIOS;
const live = args.includes('--live'), out = path.resolve(ROOT, value('--out', suite === 'adversarial' ? (live ? 'reports/adversarial-live.html' : 'tmp/adversarial-report.html') : (live ? 'reports/architecture-live.html' : 'reports/architecture-report.html')));
const positive = (key, fallback, max) => { const n = Number(value(key, fallback)); if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${key} 必须为1～${max}的整数`); return n; };
const limit = positive('--limit', scenarios.length, scenarios.length), repeat = positive('--repeat', 1, 5);
const concurrency = positive('--concurrency', 1, 3);
const selected = value('--case', '') ? scenarios.filter(s => s.id === value('--case', '')) : scenarios.slice(0, limit);
if (!selected.length) throw new Error('未找到对应测试用例');
let llm, blockedReason = '', modelName = value('--model', '');
if (live) {
  const { CONFIG_PATH, DEFAULTS, deepMerge } = await import('../src/config.js');
  const cfg = deepMerge(DEFAULTS, fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {});
  if (process.env.DEEPSEEK_API_KEY) cfg.llm.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.LLM_BASE_URL) cfg.llm.baseUrl = process.env.LLM_BASE_URL;
  cfg.llm.model = modelName || cfg.llm.model;
  modelName = cfg.llm.model;
  if (!cfg.llm.apiKey || cfg.llm.apiKey.startsWith('YOUR_')) blockedReason = '缺少模型凭据：请在环境设置中安全填写 DEEPSEEK_API_KEY，或在本机配置 llm.apiKey；不要把密钥发到聊天里。';
  else {
    const { LLM } = await import('../src/llm.js');
    llm = new LLM(cfg.llm, { debug() {}, warn: s => console.log(`[模型] ${s}`) });
  }
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
const report = { version: 1, suite, suiteHash: createHash('sha256').update(JSON.stringify(selected)).digest('hex'), rubric: suite === 'adversarial' ? 'adversarial-v1' : 'routing-v2', generatedAt: new Date().toISOString(), revision, dirty, node: process.version, engine: tests, live: { requested: live, model: modelName, blockedReason, results: [], selected: selected.map(s => s.id), repeat, concurrency, completed: false }, scenarios: selected, manual: MANUAL_CASES, ms: 0 };
function save() {
  report.ms = Date.now() - started; report.generatedAt = new Date().toISOString();
  report.summary = summarizeResults(selected, report.live.results, repeat);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderReport(report));
  fs.writeFileSync(out.replace(/\.html$/i, '') + '.json', JSON.stringify(report, null, 2));
}
save();
if (live && llm) {
  console.log(`真实模型：${llm.cfg.model}；${selected.length} 个场景 × ${repeat} 次。只有文本API收费；工具全部模拟。每个场景结束自动保存。`);
  const { evaluateScenario } = await import('./architecture-eval-core.mjs');
  const jobs = Array.from({ length: repeat }, (_, i) => selected.map(scenario => ({ scenario, round: i + 1 }))).flat();
  let cursor = 0, stopped = false;
  async function worker() {
    while (!stopped && cursor < jobs.length) {
      const { scenario, round } = jobs[cursor++];
      console.log(`[${round}/${repeat}] ${scenario.id} ${scenario.category}`);
      const result = await evaluateScenario(scenario, llm);
      report.live.results.push({ ...result, round });
      report.live.results.sort((a,b) => a.round-b.round || selected.findIndex(s=>s.id===a.id)-selected.findIndex(s=>s.id===b.id));
      console.log(`  ${scenario.id}: ${result.status} / ${Math.round(result.ms / 1000)}秒`);
      if (result.status === 'error') {
        const fatal = result.turns.some(t => t.serviceErrors.some(e => [400,401,402,403,404,422,429].includes(e.status)));
        if (fatal) stopped = true;
        report.live.blockedReason = fatal ? '模型服务配置、权限或额度异常，已停止安排后续场景；已有请求会结束。' : '部分场景发生服务错误，其他独立场景继续；服务错误不计入语义分数。';
      }
      save();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  report.live.completed = report.live.results.length === selected.length * repeat && report.live.results.every(r => r.status !== 'error');
  report.live.usage = { ...llm.stats }; save();
}
console.log(`HTML：${out}\nJSON：${out.replace(/\.html$/i, '')}.json`);
console.log(JSON.stringify(report.summary, null, 2));
if (report.live.blockedReason) console.log(report.live.blockedReason);
if (tests.some(t => t.status === 'fail') || report.live.results.some(r => ['fail', 'error'].includes(r.status)) || (live && !report.live.completed)) process.exitCode = 1;
