import fs from 'node:fs';
import path from 'node:path';
import { judgeReview } from './response-quality-report.mjs';

const root=process.argv[2]||'tmp';
const labels={before:'修改前，同一套16题',after:'第一版修复，同一套16题',reserve:'最终版本，另换10题'};
const runs=Object.entries(labels).map(([name,label])=>{
  const dir=path.join(root,`casual-chat-${name}`);
  const report=JSON.parse(fs.readFileSync(path.join(dir,'results.json'),'utf8'));
  const reviews=JSON.parse(fs.readFileSync(path.join(dir,'reviews.json'),'utf8'));
  const items=report.results.map(result=>({result,review:reviews[result.id],judgement:judgeReview(result,reviews[result.id])}));
  const counts=Object.fromEntries(['satisfactory','needs_work','service_error','unreviewed'].map(s=>[s,items.filter(i=>i.judgement.status===s).length]));
  return {name,label,report,items,counts,turns:items.reduce((n,i)=>n+i.result.turns.length,0)};
});
const lines=['# 闲聊与标点处理：修复及实测','',
  '本轮检查截图里的句号报错，以及口语、玩笑和任务混合表达。使用真实 deepseek-v4-pro、仓库默认人格和隔离磁盘记忆；没有连接真实QQ，也没有训练模型权重。文档工具仅检查排队及参数，本轮没有生成或交付Office文件。','',
  '评分由Codex逐条检查实际回复和工具/状态记录，不是独立用户满意度调查。六维各0～2分，总分至少10且无0分、无关键错误才达标。题目与标准在各轮调用前固定，失败未被重跑结果覆盖。','',
  '| 版本 | 场景/轮数 | 达标 | 未达标 | 服务错误 |','| --- | --- | --- | --- | --- |',
  ...runs.map(r=>`| ${r.label} | ${r.items.length}/${r.turns} | ${r.counts.satisfactory} | ${r.counts.needs_work} | ${r.counts.service_error} |`),'',
  '修改前把独立句号、逗号、省略号要求成“任务需求”，并曾在明确暂不执行的草稿后因👍排队生成。第一版解决这些问题，但对只带日程附件的省略输入，曾虚假承诺提醒。最终版保留附件只读边界，另用新材料测试，没有再次出现该承诺。','',
  '最终10题均未出现任务结构错误；标点/表情没有触发任务，明确制作与记忆增删仍执行。内容评分仍有1项未达标：饼干玩笑中出现“三秒法则”的不可靠暗示。该失败保留，不能把路由正常等同于所有回复都满意。','',
  '同一16题的比较只反映这组样本，最终10题是不同题目，不能用两组比例计算能力提升。当前云端代码已修改，尚未更新用户正在运行的QQ进程。','',
  '## 本地验证','',
  '- 最终全量240项Node测试通过；随后新增的真实入口集成测试1项通过，共241项。',
  '- 入口测试实际启动机器人子进程，用本地HTTP模型和模拟OneBot注入句号，保留历史音频摘要；只有1次纯文本模型调用，无任务JSON要求、无工具。',
  '- 受控复现使用相同“模型始终返回普通文本”的故障：修改前两次JSON校验后报错；修改后一次自然接话。详见 casual-chat-mechanism-comparison.json。','',
  '## 逐题实际回复',''];
for(const run of runs){
  lines.push(`### ${run.label}`,'');
  for(const {result,review,judgement} of run.items){
    lines.push(`#### ${result.id} · ${judgement.status==='satisfactory'?'达标':judgement.status==='needs_work'?'未达标':judgement.status} · ${judgement.total??'—'}/12`,'');
    const spec=run.report.cases.find(c=>c.id===result.id);
    lines.push(`标准：${spec.criteria.join('；')}`,'');
    for(const t of result.turns){
      lines.push(`用户：${t.input}`,'',...t.reply.split('\n').map(s=>`> ${s}`),'',
        `实际工具：${t.calls.map(c=>c.name).join('、')||'无'}；处理状态：${t.trace.status}；任务状态：${t.tasks?.map(x=>x.status).join('、')||'无'}。`,'');
    }
    lines.push(`复核：${review.rationale}`,'');
  }
}
const summary={scope:'real model; isolated memory; document jobs queued only; no real QQ or artifact generation',runs:runs.map(({name,counts,turns,report})=>({name,counts,turns,suiteHash:report.manifest.suiteHash,usage:report.usage}))};
fs.writeFileSync(path.join(root,'casual-chat-summary.md'),lines.join('\n'));
fs.writeFileSync(path.join(root,'casual-chat-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
