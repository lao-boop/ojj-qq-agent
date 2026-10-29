import fs from 'node:fs';
import path from 'node:path';
import { judgeReview } from './response-quality-report.mjs';

const args=process.argv.slice(2),value=(key,fallback)=>args.find(a=>a.startsWith(`${key}=`))?.slice(key.length+1)||fallback;
const out=path.resolve(value('--out','tmp/response-quality-comparison.html'));
const read=(label,dir)=>({label,dir:path.resolve(dir),report:JSON.parse(fs.readFileSync(path.join(dir,'results.json'))),reviews:JSON.parse(fs.readFileSync(path.join(dir,'reviews.json')))});
const runs=[read('修改前',value('--before','tmp/response-quality-live')),read('修改后',value('--after','tmp/response-quality-after'))];
const [before,after]=runs;
if(before.report.manifest.suiteHash!==after.report.manifest.suiteHash||before.report.manifest.model!==after.report.manifest.model||JSON.stringify(before.report.manifest.rubric)!==JSON.stringify(after.report.manifest.rubric))throw new Error('题库、模型或评分标准不一致');
if(runs.some(r=>!r.report.completed||r.report.results.length!==r.report.cases.length))throw new Error('必须完整尝试所有场景后再对比');
const labels={satisfactory:'达标',needs_work:'需改进',service_error:'服务异常',unreviewed:'待复核'};
const rows=before.report.cases.map(spec=>{
  const versions=runs.map(run=>{const result=run.report.results.find(r=>r.id===spec.id);if(!result)throw new Error(`Missing case: ${spec.id}`);const review=run.reviews[spec.id];const grade=judgeReview(result,review);if(grade.status==='unreviewed')throw new Error(`Review pending: ${spec.id}`);return {result,review,...grade};});
  const [a,b]=versions;
  const change=a.status!=='satisfactory'&&b.status==='satisfactory'?'改善':a.status==='satisfactory'&&b.status!=='satisfactory'?'退步':'达标状态未变';
  return {spec,versions,change,scoreDelta:a.total!==null&&b.total!==null?b.total-a.total:null};
});
const totals=runs.map((run,index)=>{
  const v=rows.map(r=>r.versions[index]);const scored=v.filter(x=>x.total!==null);
  return {label:run.label,total:v.length,satisfactory:v.filter(x=>x.status==='satisfactory').length,needsWork:v.filter(x=>x.status==='needs_work').length,serviceErrors:v.filter(x=>x.status==='service_error').length,
    textPassed:rows.filter(r=>!r.spec.artifact&&r.versions[index].status==='satisfactory').length,filesPassed:rows.filter(r=>r.spec.artifact&&r.versions[index].status==='satisfactory').length,
    mean:scored.length?scored.reduce((n,x)=>n+x.total,0)/scored.length:null,usage:run.report.usage};
});
const changes=Object.fromEntries(['改善','退步','达标状态未变'].map(k=>[k,rows.filter(r=>r.change===k).length]));
const percent=n=>`${(100*n).toFixed(1)}%`,e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const link=(run,file)=>path.relative(path.dirname(out),path.join(run.dir,file)).split(path.sep).join('/');
const summary=`同一套${rows.length}题：${totals[0].satisfactory}/${rows.length} → ${totals[1].satisfactory}/${rows.length} 达标，${percent(totals[0].satisfactory/rows.length)} → ${percent(totals[1].satisfactory/rows.length)}。`;
const method='同一题库、deepseek-v4-pro、评分门槛和运行入口；评分由Codex按实际回复及文件内容复核，非独立用户满意度调查。题目已经用于指导修复，只有各一轮完整样本，不能推导生产准确率。修改包含提示词、程序反馈、文档结构与生成温度；不能单独归因于其中某一项。未拼接重刷结果。检索和记忆隔离模拟，Office文件真实生成；不测QQ交付或视觉排版审美。';
const implementation=[
  '缺失字段翻译成用户能执行的补充说明；优先检查材料和能力条件，不再将inputRef等内部键当成回复。',
  '按实际未完成的查询/操作反馈，并提供核实方向；查询失败继续阻止依赖文档生成，不采信模型口头完成声明。',
  '回复规则保留硬预算、固定格式与数量限制；过敏食品推荐先核对配料、标识和交叉接触，不能凭食品名称保证安全；允许提供完整来源URL。',
  'PPT总页数包含封面结尾，正文预算减2，限定主题范围并检查每批页数；Word取消最低字数，保留原事实与节数。结构错误最多修复一次。',
  'Excel内部文件后缀修正为xlsx；Word/PPT生成温度降至0.2，减少无根据扩写。',
];
const table=rows.map(r=>`| ${r.spec.id} | ${r.versions.map(v=>`${labels[v.status]} ${v.total??'—'}/12`).join(' | ')} | ${r.change} |`).join('\n');
let md=`# 回答质量修复前后对比\n\n${summary}\n\n${changes.改善}项由未达标变为达标，${changes.退步}项退步。main未修改，工作分支为fix/architecture-routing-report。\n\n| 版本 | 达标 | 需改进 | 服务异常 | 文字/多轮 | 真实文件 | 平均分 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${totals.map(t=>`| ${t.label} | ${t.satisfactory}/${t.total} | ${t.needsWork} | ${t.serviceErrors} | ${t.textPassed}/18 | ${t.filesPassed}/3 | ${t.mean?.toFixed(2)??'—'}/12 |`).join('\n')}\n\n## 修改内容\n\n${implementation.map(s=>`- ${s}`).join('\n')}\n\n## 全部题目\n\n| 场景 | 修改前 | 修改后 | 变化 |\n| --- | --- | --- | --- |\n${table}\n\n## 逐题依据\n\n`;
for(const row of rows){md+=`### ${row.spec.id}\n\n`;for(const [i,v] of row.versions.entries())md+=`${runs[i].label}：${labels[v.status]}，${v.total??'—'}/12。${v.review?.rationale||'服务异常，无内容评分。'}\n\n`;}
md+=`## 方法与限制\n\n${method}\n\n本地回归186项通过；新增测试实际读取PPT页数、Word小节和Excel数据，并检查失败回执及附件缺失提示。最后补充页数语义提示后，相关24项测试另行通过。\n\n题库哈希：\`${before.report.manifest.suiteHash}\`。旧的97.5%是操作契约测试，与本报告的内容达标率不是同一指标。\n\n## 原始记录与真实文件\n\n${runs.map(run=>`- ${run.label}：[逐题交互报告](${link(run,'report.html')}) / [原始结果](${link(run,'results.json')}) / [评分依据](${link(run,'reviews.json')})\n  文件：[Word](${link(run,'artifact-docx.docx')}) / [Excel](${link(run,'artifact-excel.xlsx')}) / [PPT](${link(run,'artifact-ppt.pptx')})`).join('\n')}\n`;
const cards=rows.map(row=>`<article data-change="${row.change}"><h2>${e(row.spec.id)} <small>${row.change}</small></h2><details><summary>验收要求</summary><ul>${row.spec.criteria.map(c=>`<li>${e(c)}</li>`).join('')}</ul></details><div class="pair">${row.versions.map((v,i)=>`<section><h3>${runs[i].label} · ${labels[v.status]} · ${v.total??'—'}/12</h3>${v.result.turns.map(t=>`<p class="question">${e(t.input)}</p><pre>${e(t.reply)}</pre>`).join('')}<p>${e(v.review?.rationale||'服务异常，不评分')}</p>${v.result.artifacts.map(a=>`<a href="${e(link(runs[i],a.file))}">下载${e(a.deliveredName)}</a>`).join('')}</section>`).join('')}</div></article>`).join('');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>回答质量修改前后对比</title><style>body{max-width:1280px;margin:30px auto;padding:0 20px;background:#f5f7fb;color:#172235;font:16px/1.65 system-ui}h1{font-size:28px}h2{font-size:20px}h3{font-size:17px}article,.summary{background:#fff;border:1px solid #dbe3ee;border-radius:10px;padding:20px;margin:18px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#edf5f1;padding:12px;border-radius:6px}.question{font-weight:600}small{font-size:13px;color:#667080}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #dde5ee;padding:8px}button{margin:4px;padding:8px 14px;background:white;border:1px solid #b8c4d4;border-radius:5px;cursor:pointer}a{color:#245baf}@media(max-width:800px){.pair{grid-template-columns:1fr}}</style><h1>回答与文件质量：修改前后对比</h1><p>${e(summary)}</p><p>${changes.改善}项改善，${changes.退步}项退步。main未修改。</p><section class="summary"><table><tr><th>版本</th><th>达标</th><th>需改进</th><th>服务异常</th><th>平均分</th></tr>${totals.map(t=>`<tr><td>${t.label}</td><td>${t.satisfactory}/${t.total}</td><td>${t.needsWork}</td><td>${t.serviceErrors}</td><td>${t.mean?.toFixed(2)??'—'}/12</td></tr>`).join('')}</table><p>${e(method)}</p><a href="${e(path.basename(out).replace(/\.html$/,'.md'))}">完整文字报告与验证说明</a></section><nav>${['全部','改善','退步','达标状态未变'].map(v=>`<button data-filter="${v}">${v}</button>`).join('')}</nav>${cards}<script>document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>document.querySelectorAll('article').forEach(a=>a.hidden=b.dataset.filter!=='全部'&&a.dataset.change!==b.dataset.filter));</script></html>`;
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,html);fs.writeFileSync(out.replace(/\.html$/,'.md'),md);
fs.writeFileSync(out.replace(/\.html$/,'.json'),JSON.stringify({suiteHash:before.report.manifest.suiteHash,model:before.report.manifest.model,totals,changes,rows:rows.map(r=>({id:r.spec.id,change:r.change,scoreDelta:r.scoreDelta,grades:r.versions.map(v=>({status:v.status,total:v.total}))})),method},null,2));
console.log(summary);console.log(out);
