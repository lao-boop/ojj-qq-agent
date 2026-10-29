import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { judgeReview } from './response-quality-report.mjs';

const args=process.argv.slice(2);
const value=(name,fallback)=>args.find(a=>a.startsWith(`${name}=`))?.slice(name.length+1)||fallback;
const out=path.resolve(value('--out','tmp/numeric-quality-comparison.html'));
const errata=JSON.parse(fs.readFileSync('tmp/holdout-errata.json','utf8'));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const read=(label,dir)=>({label,dir:path.resolve(dir),report:JSON.parse(fs.readFileSync(path.join(dir,'results.json'))),reviews:JSON.parse(fs.readFileSync(path.join(dir,'reviews.json')))});
const runs=[read('修改前',value('--before','tmp/holdout-before')),read('首次接入（保留失败）',value('--candidate','tmp/holdout-after')),read('最终修复',value('--after','tmp/holdout-final'))];
const regression=read('原题回归',value('--regression','tmp/numeric-regression-final'));
const normalized=run=>run.report.cases.map(c=>errata[c.id]?{...c,criteria:errata[c.id].criteria}:c);
const canonical=hash(normalized(runs[0]));
for(const run of [...runs,regression]) {
  if(!run.report.completed||run.report.results.length!==run.report.cases.length)throw new Error(`Incomplete run: ${run.label}`);
  if(run.report.manifest.model!==runs[0].report.manifest.model||JSON.stringify(run.report.manifest.rubric)!==JSON.stringify(runs[0].report.manifest.rubric))throw new Error('Model or rubric changed');
  if(run!==regression&&hash(normalized(run))!==canonical)throw new Error('Case input or corrected criteria changed');
  for(const result of run.report.results)if(judgeReview(result,run.reviews[result.id]).status==='unreviewed')throw new Error(`Unreviewed ${run.label}/${result.id}`);
}
const spec=runs[0].report.cases;
const grades=run=>run.report.results.map(result=>({...judgeReview(result,run.reviews[result.id]),id:result.id,result,review:run.reviews[result.id]}));
const byRun=runs.map(grades);
const stats=(run,list)=>{
  const ids=new Map(run.report.cases.map(c=>[c.id,c]));
  const count=rows=>({attempted:rows.length,passed:rows.filter(x=>x.status==='satisfactory').length,failed:rows.filter(x=>x.status==='needs_work').length,serviceErrors:rows.filter(x=>x.status==='service_error').length,scored:rows.filter(x=>x.total!==null).length});
  const valid=list.filter(g=>g.total!==null), latencies=list.filter(g=>g.status!=='service_error').map(g=>g.result.ms).sort((a,b)=>a-b);
  const calls=run.report.results.flatMap(r=>r.turns.flatMap(t=>t.calls));
  return {label:run.label,...count(list),unique:count(list.filter(g=>!ids.get(g.id).repeatOf)),repeats:count(list.filter(g=>ids.get(g.id).repeatOf)),mean:valid.reduce((s,g)=>s+g.total,0)/valid.length,medianScenarioSeconds:latencies.length?latencies[Math.floor(latencies.length/2)]/1000:null,modelUsage:run.report.usage,numericCalls:calls.filter(c=>c.name==='verify_numbers').length,toolErrors:calls.filter(c=>String(c.result).startsWith('工具执行失败')).length};
};
const totals=runs.map((run,i)=>stats(run,byRun[i]));
const matched=spec.map(c=>({spec:c,versions:byRun.map(list=>list.find(g=>g.id===c.id))}));
const common=matched.filter(r=>[r.versions[0],r.versions[2]].every(g=>g.total!==null));
const paired={scenarios:common.length,beforePassed:common.filter(r=>r.versions[0].status==='satisfactory').length,afterPassed:common.filter(r=>r.versions[2].status==='satisfactory').length};
const repeats=runs.map((run,i)=>({label:run.label,items:spec.filter(c=>c.repeatOf).map(c=>{const first=byRun[i].find(g=>g.id===c.repeatOf),second=byRun[i].find(g=>g.id===c.id);return {id:c.repeatOf,first:first.status,repeat:second.status,bothPassed:first.status==='satisfactory'&&second.status==='satisfactory'};})}));
const labels={satisfactory:'达标',needs_work:'需改进',service_error:'服务异常'};
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=(run,file)=>path.relative(path.dirname(out),path.join(run.dir,file)).split(path.sep).join('/');
const rate=t=>t.scored?`${(100*t.passed/t.scored).toFixed(1)}%`:'—';
const method='20个独立新场景，加4个关键场景各重复一次，共24场景、36轮用户输入。测试在实施前固定；首次新题输出暴露通用布尔参数格式问题后进行了完整重跑，最终轮已属于已知题回归。三轮分别运行，不拼接单题重试的最好结果。Codex逐题复核实际可见回复、工具回执和任务参数，非独立人工满意度调查。服务异常不评分，另列尝试总数与共同有效样本。数字工具真实执行，文件仅检查任务排队参数，本轮未渲染Office文件、未发送QQ、未测试真实长期记忆。';
const implementation=[
  '增加只读精确核算工具：有理数计算金额、差额、比例与数量，输出舍入标记；不执行任意代码。',
  '程序逐条核对预算、重量等数值条件和是否条件；未知属性不算满足条件，不合格推荐会报错。',
  '核算操作纳入工作流回执检查；模型跳过必需工具不能报完成。普通编号复述不触发核算。',
  '意图识别读取最近对话，采用更正后的要求；区分聊天修改和待执行任务修改。',
  '新题揭示布尔值被序列化成字符串的问题；仅兼容准确的true/false字面量，保留未知，不猜测。',
];
const summary=`最终${totals[2].passed}/${totals[2].attempted}场景达标；内容评分${totals[2].passed}/${totals[2].scored}（${rate(totals[2])}），服务异常${totals[2].serviceErrors}项。`;
const tableHead='| 版本 | 达标/全部尝试 | 内容达标/可评分 | 服务异常 | 独立场景达标/尝试 | 重复场景达标/尝试 | 平均分 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |';
let md=`# 精确核算与多轮新题测试\n\n${summary}\n\n${tableHead}\n${totals.map(t=>`| ${t.label} | ${t.passed}/${t.attempted} | ${t.passed}/${t.scored}（${rate(t)}） | ${t.serviceErrors} | ${t.unique.passed}/${t.unique.attempted} | ${t.repeats.passed}/${t.repeats.attempted} | ${t.mean.toFixed(2)}/12 |`).join('\n')}\n\n修改前和最终轮共同可评分的${paired.scenarios}场景：${paired.beforePassed} → ${paired.afterPassed}达标。不能把超时转为成功直接解释为内容能力提高。\n\n## 改动\n\n${implementation.map(s=>`- ${s}`).join('\n')}\n\n工作分支：fix/architecture-routing-report；main未修改；未提交、推送或部署。\n\n## 原题回归\n\n`;
for(const g of grades(regression))md+=`- ${g.id}：${labels[g.status]}，${g.total??'—'}/12。${g.review?.rationale||'服务异常不评分'}\n`;
md+='\n## 全部新题\n\n| 场景 | 修改前 | 首次接入 | 最终修复 |\n| --- | --- | --- | --- |\n'+matched.map(r=>`| ${r.spec.id}${r.spec.repeatOf?'（重复）':''} | ${r.versions.map(g=>`${labels[g.status]} ${g.total??'—'}/12`).join(' | ')} |`).join('\n');
md+='\n\n## 预先安排的重复测试\n\n| 版本 | 两次均达标 | 情况 |\n| --- | ---: | --- |\n'+repeats.map(r=>`| ${r.label} | ${r.items.filter(x=>x.bothPassed).length}/${r.items.length} | ${r.items.map(x=>`${x.id}：${labels[x.first]} / ${labels[x.repeat]}`).join('；')} |`).join('\n');
md+='\n\n## 逐题依据\n\n';
for(const row of matched){md+=`### ${row.spec.id}\n\n`;for(const [i,g] of row.versions.entries())md+=`${runs[i].label}：${g.review?.rationale||'模型服务超时，未得到完整回答，不评分。'}\n\n`;}
md+=`## 运行开销\n\n| 版本 | 成功模型调用 | 输入tokens | 输出tokens | 核算工具调用 | 场景耗时中位数（秒） |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${totals.map(t=>`| ${t.label} | ${t.modelUsage.calls} | ${t.modelUsage.promptTokens} | ${t.modelUsage.completionTokens} | ${t.numericCalls} | ${t.medianScenarioSeconds.toFixed(1)} |`).join('\n')}\n\n耗时受并发、服务波动及多轮长度影响，不能当成严格性能基准。核算工具不调用额外服务，但模型读取回执通常增加一轮生成。\n\n## 方法与限制\n\n${method}\n\n未微调模型权重。仍依赖模型准确提取输入、条件并组织最终文字；工具正确不代表任何自然语言回答都有保证。\n\n本地195项测试通过；包含精确小数、边界、未知条件、布尔字面量、无合格方案、跳过核算/错误推荐不能报完成。报告渲染相关3项检查通过。\n\n评审勘误：${errata['decimal-refund'].reason}\n\n## 原始证据\n\n${[...runs,regression].map(run=>`- ${run.label}：[逐题回复](${link(run,'report.html')}) / [原始结果](${link(run,'results.json')}) / [代码及题库哈希](${link(run,'manifest.json')}) / [评分依据](${link(run,'reviews.json')})`).join('\n')}\n`;
const cards=matched.map(row=>`<article><h2>${e(row.spec.id)}${row.spec.repeatOf?' · 重复运行':''}</h2><div class="columns">${row.versions.map((g,i)=>`<section><h3>${runs[i].label} · ${labels[g.status]} · ${g.total??'—'}/12</h3>${g.result.turns.map(t=>`<p class="input">${e(t.input)}</p><pre>${e(t.reply)}</pre>`).join('')}<p>${e(g.review?.rationale||'服务异常，不评分')}</p><details><summary>工具回执</summary><pre>${e(JSON.stringify(g.result.turns.map(t=>t.calls),null,2))}</pre></details></section>`).join('')}</div></article>`).join('');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>精确核算与多轮新题测试</title><style>body{max-width:1450px;margin:25px auto;padding:0 20px;background:#f3f6fa;color:#172235;font:16px/1.7 system-ui}article,.summary{background:white;border:1px solid #d7e0ec;border-radius:10px;padding:20px;margin:20px 0}h1{font-size:27px}h2{font-size:20px}h3{font-size:16px}.columns{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#edf6f1;padding:12px;border-radius:6px}.input{font-weight:600}td,th{padding:8px;border-bottom:1px solid #dae2ed;text-align:left}a{color:#245baf}@media(max-width:1050px){.columns{grid-template-columns:1fr}}</style><h1>精确核算与多轮新题测试</h1><p>${e(summary)}</p><section class="summary"><table><tr><th>版本</th><th>达标/全部尝试</th><th>内容达标率</th><th>服务异常</th></tr>${totals.map(t=>`<tr><td>${t.label}</td><td>${t.passed}/${t.attempted}</td><td>${t.passed}/${t.scored}（${rate(t)}）</td><td>${t.serviceErrors}</td></tr>`).join('')}</table><p>共同可评分${paired.scenarios}场景：${paired.beforePassed} → ${paired.afterPassed}达标。</p><p>${e(method)}</p><p>评审勘误：${e(errata['decimal-refund'].reason)}</p><a href="${e(path.basename(out).replace(/\.html$/,'.md'))}">完整文字报告、开销、原题回归与验证</a></section>${cards}</html>`;
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,html);fs.writeFileSync(out.replace(/\.html$/,'.md'),md);
fs.writeFileSync(out.replace(/\.html$/,'.json'),JSON.stringify({totals,paired,repeats,regression:stats(regression,grades(regression)),correctedSuiteHash:canonical,originalSuiteHashes:runs.map(r=>r.report.manifest.suiteHash),errata,method},null,2));
console.log(summary);console.log(JSON.stringify({totals,paired},null,2));
