// Fifty current-v3 inputs. No production transport, no model request unless --live.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
const root=path.resolve(import.meta.dirname,'..');
const {values:o}=parseArgs({options:{live:{type:'boolean'},out:{type:'string'},config:{type:'string'},'resume-from':{type:'string'}}});
const casesFile='experiments/secretary/suite-v3-50.json';
const cases=JSON.parse(fs.readFileSync(path.join(root,casesFile),'utf8'));
const selected=cases.flatMap(c=>c.variants.map(variant=>({...c,variant,id:`${c.id}-${variant}`,caseId:c.id})));
if(selected.length!==50 || new Set(selected.map(c=>c.id)).size!==50)throw Error('Expected exactly 50 unique inputs');
const out=path.resolve(o.out||path.join(root,'tmp',`secretary-v3-50-${Date.now()}`));
fs.mkdirSync(out,{recursive:true});
if(fs.existsSync(path.join(out,'suite.json')))throw Error('Use a new output directory; never overwrite results');
const sha=file=>createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hashes=Object.fromEntries([casesFile,'src/wecom-scheduled-briefing.js','src/wecom-secretary.js','src/llm.js','scripts/experiment-secretary.mjs','scripts/evaluate-secretary-v3-50.mjs'].map(f=>[f,sha(f)]));
const resume=o['resume-from']?path.resolve(o['resume-from']):null;
if(resume){
 if(out.startsWith(resume+path.sep))throw Error("Output must not be inside the resumed directory");
 const previous=read(path.join(resume,'suite.json'));
 if(!previous || previous.mode!==(o.live?'real-model':'wiring-only') || JSON.stringify(previous.hashes)!==JSON.stringify(hashes))throw Error('Cannot resume: different suite, source or mode');
}
const run={suite:'v3-50-v1',mode:o.live?'real-model':'wiring-only',algorithm:'source-first-v3',planned:50,knownInputs:10,newInputs:40,historyMode:'fixture',requestTimeoutMs:60000,requestAttempts:1,started:new Date().toISOString(),hashes,resumedFrom:resume,runs:[]};
// Retain the previous attempt tree too, so recovery never hides earlier failures.
if(resume)fs.cpSync(resume,path.join(out,'previous-attempt'),{recursive:true,filter:src=>!src.endsWith('.tar.gz')});
function priorCase(id){
 let dir=resume,fallback=null;
 while(dir){
  const candidate=path.join(dir,id),manifest=read(path.join(candidate,'manifest.json'));
  if(manifest){
   fallback ||= candidate;
   if(manifest.results.some(r=>r.id===id && r.status==='completed'))return candidate;
  }
  const previous=path.join(dir,'previous-attempt');
  dir=fs.existsSync(path.join(previous,'suite.json'))?previous:null;
 }
 return fallback;
}
const save=()=>fs.writeFileSync(path.join(out,'suite.json'),JSON.stringify(run,null,2));
function report(){
 const rows=selected.map(c=>{
  const x=run.runs.find(r=>r.id===c.id),dir=path.join(out,c.id);
  const result=read(path.join(dir,c.id+'.json')),calls=read(path.join(dir,c.id+'-calls.json'))||[];
  const known=calls.filter(c=>Number.isFinite(c.response?.usage?.total_tokens));
  return {id:c.id,cohort:c.cohort,status:x?.result?.status||(x?'interrupted':'not-run'),reused:Boolean(x?.result?.reusedFrom),failure:x?.result?.error||null,history:c.history,employee:c[c.variant],text:result?.deliveries.filter(d=>d.stage==='current').map(d=>d.text).join('\n\n')||'',calls:calls.length,seconds:calls.length?calls.reduce((s,c)=>s+(c.elapsedMs||0),0)/1000:null,tokens:calls.length && known.length===calls.length?known.reduce((s,c)=>s+c.response.usage.total_tokens,0):null,knownTokens:known.reduce((s,c)=>s+c.response.usage.total_tokens,0),review:c.review};
 });
 const completed=rows.filter(r=>r.status==='completed').length;
 const failed=rows.filter(r=>r.status==='failed'||r.status==='interrupted').length;
 const pending=rows.filter(r=>r.status==='not-run').length;
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({mode:run.mode,completed,failed,pending,rows},null,2));
 const intro=`v3：${completed}/50生成完成，失败或中断${failed}，未运行${pending}。模式：${run.mode}。完成不是质量通过。历史与收件人为替身；缺失Token记未知。复用行的耗时和Token来自原运行，不计作新调用。`;
 const md=['# 小鲸鱼v3 · 50次测试',intro,`停止原因：${run.stoppedReason||'无'}。旧失败记录如有保留在previous-attempt。`];
 const sections=rows.map(r=>{
  const perf=`${r.status} · ${r.seconds===null?'尚无计时':r.seconds.toFixed(3)+'秒'} · Token ${r.tokens??'未知'}${r.reused?' · 复用已完成结果':''}`;
  md.push(`\n## ${r.id}\n\n${perf}\n\n历史原话：${r.history.join('\n')||'无'}\n\n员工原话：${r.employee.join('\n\n')}\n\n实际转告：${r.text||r.failure||'尚未得到正文'}\n\n评阅要点（不是分数）：${r.review}`);
  return `<section><h2>${esc(r.id)}</h2><p>${esc(perf)}</p><h3>历史原话</h3><blockquote>${esc(r.history.join('\n')||'无')}</blockquote><h3>员工原话</h3><blockquote>${esc(r.employee.join('\n\n'))}</blockquote><h3>实际转告</h3><blockquote class="answer">${esc(r.text||r.failure||'尚未得到正文')}</blockquote><p>评阅要点（不是分数）：${esc(r.review)}</p></section>`;
 });
 fs.writeFileSync(path.join(out,'report.md'),md.join('\n\n'));
 fs.writeFileSync(path.join(out,'report.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小鲸鱼v3 · 50次测试</title><style>body{max-width:1000px;margin:30px auto;padding:0 20px;color:#243f52;font:16px/1.8 system-ui}header{background:#17445e;color:white;padding:24px}section{border-top:2px solid #dce7ee;margin-top:30px;padding-top:20px}blockquote{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf3f6;margin:12px 0;padding:16px}.answer{border-left:4px solid #278b83}h2{font-size:22px}@media print{section{break-inside:avoid}}</style><header><h1>小鲸鱼v3 · 50次测试</h1><p>${esc(intro)}</p><p>停止原因：${esc(run.stoppedReason||'无')}。耗时是本轮模型调用之和，不是企微送达延迟。</p></header>${sections.join('')}</html>`);
 return {completed,failed,pending};
}
save();report();let consecutiveFailures=0;
try{
 for(const [index,c] of selected.entries()){
  const dest=path.join(out,c.id),old=priorCase(c.id);
  const args=['scripts/experiment-secretary.mjs','--algorithm','upgraded','--history-mode','fixture','--split',c.split,'--case-id',c.caseId,'--variant',c.variant,'--cases-file',casesFile,'--out',dest,'--request-timeout-ms','60000','--request-attempts','1'];
  if(o.live)args.push('--live');if(o.config)args.push('--config',path.resolve(o.config));
  if(old && fs.existsSync(path.join(old,'manifest.json')))args.push('--resume-from',old);
  console.log(`\n[v3 ${index+1}/50] ${c.id}`);
  const child=spawnSync(process.execPath,args,{cwd:root,env:process.env,stdio:'inherit'});
  const manifest=read(path.join(dest,'manifest.json')),result=manifest?.results.find(r=>r.id===c.id)||null;
  run.runs.push({id:c.id,exitCode:child.status,result});
  if(result?.status==='completed')consecutiveFailures=0;else {consecutiveFailures++;process.exitCode=1;}
  if(child.signal || !result)run.stoppedReason='实验中断或启动校验失败；已写入的结果保留，下次续跑';
  else if(['model_http','model_transport','model_protocol'].includes(result.kind))run.stoppedReason='模型连接、鉴权或响应协议失败，暂停后续请求；修复后续跑';
  else if(consecutiveFailures>=3)run.stoppedReason='连续3个输入未完成，暂停后续请求；检查失败记录后续跑';
  save();const counts=report();console.log(`累计：完成${counts.completed}，失败${counts.failed}，待运行${counts.pending}`);
  if(run.stoppedReason)break;
 }
}finally{run.finished=new Date().toISOString();save();report();}
console.log(`\n报告：${out}/report.html\n结果目录：${out}\n只报告实际结果，未运行与失败保留；续跑不会把旧失败改成从未发生。`);
