// Paired v1/v2 experiment. No WeCom connection; real model only when --live is set.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const {values:o}=parseArgs({options:{live:{type:'boolean'},out:{type:'string'},config:{type:'string'},full:{type:'boolean'},'resume-from':{type:'string'}}});
const out=path.resolve(o.out || path.join(root,'tmp',`secretary-v2-${Date.now()}`));
fs.mkdirSync(out,{recursive:true});
if(fs.existsSync(path.join(out,'iteration.json')))throw new Error('Use a new output directory; never overwrite an experiment');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const files=['experiments/secretary/cases.json','experiments/secretary/fresh-v2.json'];
const catalog=files.flatMap(file=>JSON.parse(fs.readFileSync(path.join(root,file))).map(c=>({...c,file})));
const selected=catalog.flatMap(c=>['original','key','irrelevant'].map(variant=>({...c,variant}))).filter(c=>o.full || c.split==='fresh' || c.id==='staffing' || (c.id==='routine' && c.variant==='original'));
const run={version:'v2-paired-1',mode:o.live?'real-model':'wiring-only, NOT model answers',started:new Date().toISOString(),requestTimeoutMs:60000,requestAttempts:1,scope:o.full?'all 24 inputs':'focused 13 inputs',cases:files.map(file=>({file,sha256:sha(path.join(root,file))})),runs:[]};
const save=()=>fs.writeFileSync(path.join(out,'iteration.json'),JSON.stringify(run,null,2));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read=f=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;
function summarize(){
 const rows=run.runs.map(x=>{
  const dir=path.join(out,x.directory),r=read(path.join(dir,x.id+'.json')),calls=read(path.join(dir,x.id+'-calls.json'))||[],cs=calls.filter(c=>c.stage==='current');
  return {...x,status:x.result?.status||'not-run',text:r?.deliveries.filter(d=>d.stage==='current').map(d=>d.text).join('\n\n')||'',employee:r?.employee||[],history:r?.history||[],currentAttempted:cs.length>0,calls:cs.length,elapsedMs:cs.reduce((s,c)=>s+(c.elapsedMs||0),0),tokens:cs.reduce((s,c)=>s+(c.response?.usage?.total_tokens||0),0),truncations:cs.filter(c=>c.response?.finishReason==='length').length};
 });
 fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({mode:run.mode,scope:'current model call sum, not real delivery latency; includes failures',rows},null,2));
 const md=['# 小鲸鱼 v1 / v2 实测记录',`\n模式：${run.mode}。每请求60秒，最多1次HTTP尝试；每结构阶段最多2次。`, '\n完成不是质量通过；测试收件人，不是真实企微送达。旧报告结果不混进本次计时。'];
 const body=[];
 for(const c of selected){
  const id=`${c.id}-${c.variant}`,rs=rows.filter(r=>r.id===id);
  md.push(`\n## ${id}\n\n此前原话：${c.history.join('\n')||'无'}\n\n本轮原话：${c[c.variant].join('\n\n')}`);
  body.push(`<section><h2>${esc(id)}</h2><h3>此前 / 本轮原话</h3><blockquote>${esc([...c.history,...c[c.variant]].join('\n\n'))}</blockquote>`);
  for(const algorithm of ['previous','upgraded']){
   const r=rs.find(x=>x.algorithm===algorithm),label=algorithm==='previous'?'冻结v1（4fc65d1）':'候选v2';
   const content=r?.text||r?.result?.error||'未运行';
   const timing=r?.currentAttempted?`${(r.elapsedMs/1000).toFixed(2)}秒`:'未进入本轮生成';
   md.push(`\n### ${label}\n\n状态：${r?.status||'未运行'}；本轮模型 ${timing}；返回Token ${r?.tokens??0}${r?.reused?'；复用结果':''}${r?.result?.phase?'；失败阶段 '+r.result.phase:''}\n\n${content}`);
   body.push(`<article><h3>${label}</h3><p>状态：${esc(r?.status||'未运行')} · 本轮模型 ${esc(timing)} · 返回Token ${r?.tokens||0}${r?.reused?' · 复用':''}${r?.result?.phase?' · 失败阶段 '+esc(r.result.phase):''}</p><blockquote>${esc(content)}</blockquote></article>`);
  }
  body.push(`<p class="review">核对要点：${esc(c.review)}</p><p>评阅待填写：重要事项是否先讲；更正与未定是否准确；必要背景与主语是否清楚；无关版是否改变其他判断。</p></section>`);
  md.push(`\n评阅要点：${c.review}\n\n逐句评阅：待阅读真实答复，不自动打总分。`);
 }
 fs.writeFileSync(path.join(out,'comparison.md'),md.join('\n'));
 fs.writeFileSync(path.join(out,'comparison.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小鲸鱼 v1/v2 实测记录</title><style>body{max-width:1060px;margin:32px auto;padding:0 20px;color:#243746;font:16px/1.8 system-ui}header{background:#1f3a5f;color:white;padding:24px}section{border-top:2px solid #d8e3ed;margin:32px 0;padding-top:16px}article{background:#edf3f8;padding:14px 20px;margin:16px 0}blockquote{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;padding:14px;border-left:3px solid #7897b0}.review{font-weight:bold}h2,h3{color:#1f3a5f}button{padding:8px 16px}@media print{button{display:none}article{break-inside:avoid}}</style><header><h1>小鲸鱼 v1 / v2 对照记录</h1><p>${esc(run.mode)} · 已记录${rows.length}/${selected.length*2}个运行单元</p><p>60秒每请求；最多一次HTTP尝试。生成完成不等于质量通过，测试替身确认不等于真实企微送达。</p></header><button onclick="print()">打印 / 保存PDF</button>${body.join('')}</html>`);
}
save();let stopped=false;
try{
 for(const [index,c] of selected.entries()){
  const id=`${c.id}-${c.variant}`;
  // Alternate which algorithm runs first. No claim that this replaces randomized replication.
  for(const algorithm of index%2?['upgraded','previous']:['previous','upgraded']){
   const directory=`${id}/${algorithm}`,dest=path.join(out,directory),old=o['resume-from']?path.join(path.resolve(o['resume-from']),directory):null;
   const args=['scripts/experiment-secretary.mjs','--algorithm',algorithm,'--split',c.split,'--case-id',c.id,'--variant',c.variant,'--cases-file',c.file,'--out',dest,'--request-timeout-ms','60000','--request-attempts','1'];
   if(o.live)args.push('--live');if(o.config)args.push('--config',path.resolve(o.config));
   if(old && fs.existsSync(path.join(old,'manifest.json')))args.push('--resume-from',old);
   console.log(`\n[v1/v2 ${index+1}/${selected.length}] ${id} ${algorithm}`);
   const child=spawnSync(process.execPath,args,{cwd:root,env:process.env,stdio:'inherit'});
   const manifest=read(path.join(dest,'manifest.json')),result=manifest?.results.find(x=>x.id===id);
   run.runs.push({id,algorithm,directory,exitCode:child.status,result:result||null,reused:Boolean(result?.reusedFrom)});save();summarize();
   if(child.status!==0){process.exitCode=1;
    // A timeout is an outcome of the production-budget experiment; keep paired failures visible.
    // Invalid credentials/protocol/network or harness startup errors halt further paid requests.
    if(!result || ['model_http','model_transport','model_protocol'].includes(result.kind)){
     run.stoppedReason=result?.error||'实验启动或校验失败';stopped=true;break;
    }
   }
  }
  if(stopped)break;
 }
}finally{run.finished=new Date().toISOString();save();summarize();}
console.log(`\n结果：${out}/comparison.html\n请回传整个结果压缩包；不要只回传完成数量。`);
