import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.argv[2] || '.');
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const sections=['# 定时汇报原版 / 升级版对照\n\n本文件不自动打分。wiring-only 是测试替身，不是模型答复。失败也计入记录，不挑选成功样例。'];
for(const split of ['dev','holdout']) {
  const dirs=['baseline','upgraded'].map(a=>path.join(root,`${a}-${split}`));
  const manifests=dirs.map(d=>read(path.join(d,'manifest.json')));
  sections.push(`## ${split}\n\n`+manifests.map((m,i)=>`${i?'升级版':'原版'}：${m?`${m.mode}；模型 ${m.model || '无'}；${m.results.filter(r=>r.status==='completed').length}/${m.results.length} 个版本完成`:'未运行或缺少模型配置'}`).join('\n\n'));
  const ids=[...new Set(manifests.flatMap(m=>m?.results.map(r=>r.id)||[]))];
  for(const id of ids) {
    const results=dirs.map(d=>read(path.join(d,`${id}.json`)));
    const sample=results.find(Boolean);
    sections.push(`### ${id}\n\n此前原话：${sample?.history.join('\n\n') || '无或未取得'}\n\n员工本轮原话：\n\n${sample?.employee.join('\n\n') || '见 cases.json'}\n\n`+results.map((r,i)=>{
      const error=manifests[i]?.results.find(x=>x.id===id)?.error;
      const calls=read(path.join(dirs[i],`${id}-calls.json`)) || [];
      const current=calls.filter(c=>c.stage==='current');
      const entry=manifests[i]?.results.find(x=>x.id===id);
      const completed=entry?.status==='completed';
      const delivered=r?.deliveries.filter(d=>d.stage==='current').map(d=>d.text).join('\n\n');
      const detail=entry?.phase?`；阶段 ${entry.phase}；类别 ${entry.kind}`:'';
      const failedCalls=calls.filter(c=>c.error).map(c=>`${c.stage}：${c.errorDetails?JSON.stringify(c.errorDetails):c.error}`).join('\n\n');
      return `**${i?'升级版':'原版'}实际转告**\n\n${completed?delivered:`${entry?.status==='not-run'?'未执行':'未完成'}：${error || '未运行'}${detail}${delivered?'\n\n已产生的部分转告（流程未完成）：\n\n'+delivered:''}`}\n\n${entry?.reusedFrom?'复用上次保存的结果，未重新调用模型。\n\n':''}本轮模型请求 ${current.length} 次（含结构重试），已记录耗时 ${current.reduce((s,c)=>s+(c.elapsedMs||0),0)}ms。${failedCalls?'\n\n请求失败记录：\n\n'+failedCalls:''}`;
    }).join('\n\n')+'\n\n逐句评阅：\n\n- 重要的先讲：待评，引用原句。\n- 更正、归属、条件和未定之处：待评，引用易误解的原句。\n- 一遍听懂、正常情况是否简短：待评。\n- 与同组关键事实版 / 无关细节版比较：待评。\n');
  }
}
fs.writeFileSync(path.join(root,'comparison.md'),sections.join('\n\n'));
console.log(path.join(root,'comparison.md'));
