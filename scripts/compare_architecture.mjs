import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1) || fallback;
const inputs = [
  ['改造前', value('--before', 'tmp/intent-stress-results.json')],
  ['改造第一轮', value('--intermediate', 'tmp/hybrid-after-live.json')],
  ['修正后完整复测', value('--after', 'tmp/hybrid-final-live.json')],
].map(([label, file]) => ({ label, file: path.resolve(file), report: JSON.parse(fs.readFileSync(file, 'utf8')) }));
const out = path.resolve(value('--out', 'tmp/hybrid-comparison.html'));
const before = inputs[0].report, after = inputs[2].report;
for (const { label, report } of inputs) {
  if (report.suiteHash !== before.suiteHash || report.rubric !== before.rubric || report.live.model !== before.live.model)
    throw new Error(`${label} 与基线的题库、评分版本或模型不一致，不能直接比较`);
  if (report.summary.scenarios.pending) throw new Error(`${label} 还有未尝试的场景`);
}
const percent = n => n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`;
const status = { pass: '通过', fail: '未通过', error: '服务异常', pending: '未运行' };
const map = report => new Map(report.live.results.map(r => [`${r.id}:${r.round || 1}`, r]));
const maps = inputs.map(({ report }) => map(report));
const rows = [...maps[0]].map(([key, old]) => {
  const results = maps.map(m => m.get(key));
  if (results.some(r => !r)) throw new Error(`场景不完整：${key}`);
  const last = results[2];
  const change = old.status !== 'pass' && last.status === 'pass' ? '改善' : old.status === 'pass' && last.status !== 'pass' ? '退步' : '未变';
  const issues = last.turns.filter(t => t.status !== 'pass').flatMap(t => t.status === 'error' ? [`第${t.index}轮服务异常：${t.serviceErrors.map(e => e.kind).join('、')}`] : t.issues.map(i => `第${t.index}轮：${i}`));
  return { id: old.id, round: old.round || 1, category: before.scenarios.find(s => s.id === old.id)?.category || '', results, change, issues };
});
const counts = Object.fromEntries(['改善', '退步', '未变'].map(c => [c, rows.filter(r => r.change === c).length]));
const oldTotal = before.summary.scenarios, newTotal = after.summary.scenarios;
const delta = (newTotal.passed / newTotal.total - oldTotal.passed / oldTotal.total) * 100;
const headline = `同一套${newTotal.total}个场景：通过数 ${oldTotal.passed} → ${newTotal.passed}，全部场景通过比例 ${percent(oldTotal.passed / oldTotal.total)} → ${percent(newTotal.passed / newTotal.total)}（${delta >= 0 ? '+' : ''}${delta.toFixed(1)} 个百分点）。`;
const changes = [
  '将模型规划、各专业Agent执行、模型汇总，改为一个执行Agent共享工具历史；保留结构化任务契约和会话状态。',
  '程序控制工具权限、参数、步骤依赖和预算；检索/记忆/时间查询成功后才开放依赖它们的文档制作。',
  '区分暂缓草稿与永久禁止，保留修改/取消/状态查询；修正否定范围、正文槽位和附件定位的提示。',
  '工具参数损坏或输出截断时，整条工具回复在执行前验证，最多修复一次；重复调用复用结果，排队不表述为已送达。',
];
const limits = [
  '这是“意图识别 → 程序校验 → 模拟工具执行”的完整场景通过率，不是单独的意图标签准确率，也没有训练模型权重。',
  '三轮使用相同题库哈希、评分函数和deepseek-v4-pro。保留第一次改造结果；最终结果来自修正后的全量40题，不拼接各轮最好成绩。',
  '本次根据已知错题修改了架构、状态契约、提示词和输出预算，因此衡量的是组合改造在已知测试集上的效果。尚无独立盲测集，不能据此宣称生产准确率或单独归因于Agent数量。',
  '模型仍有波动，每版仅一轮完整采样。改造前包含一次超时补跑且并发设置有变化，后两轮并发2；不将总耗时或用量变化直接当作架构效率结论。',
  '服务异常独立列出，不能当作通过。全部场景通过比例保留所有题目为分母，可评分通过率只排除服务异常/未运行。',
  '工具全部模拟，没有真实QQ发送、媒体生成或记忆写入；图片和语音用预先解析样例，没有测OCR/ASR或实际交付质量。',
  '这次建立了现有助手的单主Agent与受控工作流；未接通企业催办、审批或主动监控，也未验证2000条群消息检索和95%目标。',
];
const summaryRows = inputs.map(({ label, report }) => {
  const s = report.summary.scenarios, t = report.summary.turns;
  return [label, s.passed, s.failed, s.serviceErrors, `${s.attempted}/${s.total}`, percent(s.passed / s.total), `${s.passed}/${s.scored} = ${percent(s.accuracy)}`, `${t.passed}/${t.total}（${t.failed}未通过、${t.serviceErrors}异常、${t.pending}未运行）`, `${report.engine.filter(t => t.status === 'pass').length}/${report.engine.length}`];
});
const headers = ['版本', '通过', '未通过', '异常', '尝试', '全部场景通过比例', '可评分通过率', '对话轮次', '本地测试'];
const categoryRows = Object.entries(before.summary.categories).map(([name, s]) => {
  const latest = after.summary.categories[name];
  return [name, `${s.passed}/${s.total}`, `${latest.passed}/${latest.total}`, `${latest.failed}未通过 / ${latest.serviceErrors}异常`];
});
const usageRows = inputs.map(({ label, report }) => {
  const u = report.live.usage || {};
  return [label, u.calls ?? '—', u.promptTokens ?? '—', u.completionTokens ?? '—', u.failures ?? '—'];
});
const relative = file => path.relative(path.dirname(out), file).split(path.sep).join('/');
const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
const mdTable = (h, r) => `| ${h.map(md).join(' | ')} |\n| ${h.map(() => '---').join(' | ')} |\n${r.map(row => `| ${row.map(md).join(' | ')} |`).join('\n')}\n`;
const htmlTable = (h, r) => `<div class="scroll"><table><thead><tr>${h.map(x => `<th>${escape(x)}</th>`).join('')}</tr></thead><tbody>${r.map(row => `<tr>${row.map(x => `<td>${escape(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const failed = rows.filter(r => r.results[2].status !== 'pass');
let markdown = `# 架构改造前后对比\n\n${headline}\n\n逐题对比：${counts.改善}项改善，${counts.退步}项退步，${counts.未变}项状态未变。main未修改；工作分支为 fix/architecture-routing-report。\n\n## 三轮完整结果\n\n${mdTable(headers, summaryRows)}\n## 改了什么\n\n${changes.map(s => `- ${s}`).join('\n')}\n\n## 分类对比\n\n${mdTable(['类别', '改造前通过', '最终通过', '最终其余结果'], categoryRows)}\n## 最终未通过或异常场景\n\n`;
for (const row of failed) {
  markdown += `### ${row.id}（${status[row.results[2].status]}）\n\n`;
  for (const t of row.results[2].turns.filter(t => t.status !== 'pass')) markdown += `第${t.index}轮用户输入：${t.text}\n\n实际回复：${t.actual.reply}\n\n评分问题：${t.status === 'error' ? t.serviceErrors.map(e => e.kind).join('；') : t.issues.join('；')}\n\n识别结果与执行记录：\n\n\`\`\`json\n${JSON.stringify({ recognizedIntent: t.actual.recognizedIntent, effectiveIntent: t.actual.intent, calls: t.actual.calls, taskStatus: t.actual.taskStatus }, null, 2)}\n\`\`\`\n\n`;
}
if (!failed.length) markdown += '本轮全部通过；仍受下面的验证范围限制。\n\n';
markdown += `## 全部场景\n\n${mdTable(['场景', '类别', '改造前', '第一轮', '最终', '变化'], rows.map(r => [r.id, r.category, ...r.results.map(s => status[s.status]), r.change]))}\n## API用量\n\n${mdTable(['版本', '调用数', '输入token', '输出token', '失败请求'], usageRows)}\n改造前统计包含超时补跑。用量用于审计，不作为独立性能结论。\n\n## 比较边界\n\n${limits.map(s => `- ${s}`).join('\n')}\n\n题库哈希：\`${before.suiteHash}\`；评分版本：\`${before.rubric}\`。\n\n## 原始证据\n\n${inputs.map(i => `- ${i.label}：[HTML](${relative(i.file).replace(/\.json$/, '.html')}) / [JSON](${relative(i.file)})`).join('\n')}\n`;
const tableRows = rows.map(r => `<tr data-change="${escape(r.change)}" data-status="${r.results[2].status}"><td><strong>${escape(r.id)}</strong></td><td>${escape(r.category)}</td>${r.results.map(s => `<td class="${s.status}">${status[s.status]}</td>`).join('')}<td>${r.change}</td><td>${escape(r.issues.join('；')) || '—'}</td></tr>`).join('');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>架构改造前后对比</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:1280px;margin:32px auto;padding:0 24px;color:#172235;background:#f5f7fb}section{background:white;border:1px solid #dbe2ed;border-radius:12px;padding:20px;margin:20px 0}h1{font-size:28px}h2{font-size:21px;margin:0 0 12px}.lead{font-size:20px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #dbe2ed;padding:10px}th{white-space:nowrap;background:#edf1f8}.pass{color:#067647}.fail{color:#b42318}.error{color:#9a6700}button{padding:8px 14px;background:#fff;border:1px solid #abbad0;border-radius:6px;cursor:pointer;margin:0 6px 12px 0}button[aria-pressed=true]{background:#1c4380;color:white}a{color:#245baf}code{word-break:break-all}li{margin-bottom:8px}</style><h1>架构改造前后对比</h1><p class="lead">${escape(headline)}</p><p>${counts.改善} 项改善 · ${counts.退步} 项退步 · ${counts.未变} 项状态未变。main 未修改；分支：fix/architecture-routing-report。</p><section><h2>三轮完整结果</h2>${htmlTable(headers, summaryRows)}</section><section><h2>改了什么</h2><ul>${changes.map(s => `<li>${escape(s)}</li>`).join('')}</ul></section><section><h2>分类结果</h2>${htmlTable(['类别', '改造前通过', '最终通过', '最终其余结果'], categoryRows)}</section><section><h2>逐题对比</h2><nav>${[['all','全部'],['改善','改善'],['退步','退步'],['remaining','最终未通过 / 异常']].map(([v,l]) => `<button data-filter="${v}" aria-pressed="${v === 'all'}">${l}</button>`).join('')}</nav><div class="scroll"><table id="cases"><thead><tr>${['场景','类别','改造前','第一轮','最终','变化','最终问题'].map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></div></section><section><h2>API用量</h2>${htmlTable(['版本','调用数','输入token','输出token','失败请求'], usageRows)}<p>改造前包含超时补跑。用量用于审计，不作为独立性能结论。</p></section><section><h2>比较边界</h2><ul>${limits.map(s => `<li>${escape(s)}</li>`).join('')}</ul><p>题库哈希：<code>${before.suiteHash}</code><br>评分版本：${escape(before.rubric)}</p></section><section><h2>完整记录</h2><ul>${inputs.map(i => `<li>${i.label}：<a href="${escape(relative(i.file).replace(/\.json$/, '.html'))}">逐轮HTML报告</a> · <a href="${escape(relative(i.file))}">原始JSON</a></li>`).join('')}<li><a href="${escape(path.basename(out).replace(/\.html$/, '.md'))}">文字报告与未通过场景详情</a></li></ul></section><script>document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('#cases tbody tr').forEach(r=>{const f=b.dataset.filter;r.hidden=!(f==='all'||f==='remaining'&&r.dataset.status!=='pass'||r.dataset.change===f)})}));</script></html>`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
fs.writeFileSync(out.replace(/\.html$/, '.md'), markdown);
fs.writeFileSync(out.replace(/\.html$/, '.json'), JSON.stringify({ generatedAt: new Date().toISOString(), suiteHash: before.suiteHash, rubric: before.rubric, model: before.live.model, counts, deltaPercentagePoints: delta, inputs: inputs.map(i => ({ label: i.label, path: relative(i.file), summary: i.report.summary, usage: i.report.live.usage })), rows: rows.map(({ results, ...r }) => ({ ...r, statuses: results.map(s => s.status) })), limits }, null, 2));
console.log(`${headline}\n报告：${out}`);
