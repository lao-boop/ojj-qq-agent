// Paired v1/v2, or --v3 for frozen v2/current v3. No WeCom connection.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const {values:o}=parseArgs({options:{live:{type:'boolean'},out:{type:'string'},config:{type:'string'},full:{type:'boolean'},v3:{type:'boolean'},'resume-from':{type:'string'}}});
const version=o.v3?'v3':'v2';
const algorithms=o.v3?['v2','upgraded']:['previous','v2'];
const labels=o.v3?{v2:'冻结v2（1df1a18）',upgraded:'候选v3'}:{previous:'冻结v1（4fc65d1）',v2:'冻结v2（1df1a18）'};
const out=path.resolve(o.out || path.join(root,'tmp',`secretary-${version}-${Date.now()}`));
fs.mkdirSync(out,{recursive:true});
if(fs.existsSync(path.join(out,'iteration.json')))throw new Error('Use a new output directory; never overwrite an experiment');
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const files=['experiments/secretary/cases.json',`experiments/secretary/fresh-${version}.json`];
const catalog=files.flatMap(file=>JSON.parse(fs.readFileSync(path.join(root,file))).map(c=>({...c,file})));
const selected=catalog.flatMap(c=>['original','key','irrelevant'].map(variant=>({...c,variant}))).filter(c=>o.full || c.split==='fresh' || c.id==='staffing' || (c.id==='routine' && c.variant==='original'));
// Keep the completion gate before any fresh paid requests. It is not a quality gate.
selected.sort((a,b)=>Number(a.split==='fresh')-Number(b.split==='fresh'));
const core=selected.filter(c=>c.split!=='fresh');
const run={version:`${version}-paired-1`,historyMode:o.v3?'fixture':'model',mode:o.live?'real-model':'wiring-only, NOT model answers',started:new Date().toISOString(),requestTimeoutMs:60000,requestAttempts:1,scope:`${selected.length} planned inputs (${core.length} core); ${o.full?'full':o.v3?'completion gate after core':'focused'}`,cases:files.map(file=>({file,sha256:sha(path.join(root,file))})),runs:[]};
const save=()=>fs.writeFileSync(path.join(out,'iteration.json'),JSON.stringify(run,null,2));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const read=f=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;
function summarize(){
 const rows=run.runs.map(x=>{
  const dir=path.join(out,x.directory),r=read(path.join(dir,x.id+'.json')),calls=read(path.join(dir,x.id+'-calls.json'))||[],cs=calls.filter(c=>c.stage==='current');
  return {...x,status:x.result?.status||'not-run',text:r?.deliveries.filter(d=>d.stage==='current').map(d=>d.text).join('\n\n')||'',employee:r?.employee||[],history:r?.history||[],currentAttempted:cs.length>0,calls:cs.length,elapsedMs:cs.reduce((s,c)=>s+(c.elapsedMs||0),0),tokens:cs.length && cs.every(c=>Number.isFinite(c.response?.usage?.total_tokens))?cs.reduce((s,c)=>s+c.response.usage.total_tokens,0):null,knownTokens:cs.reduce((s,c)=>s+(c.response?.usage?.total_tokens||0),0),truncations:cs.filter(c=>c.response?.finishReason==='length').length};
 });
 fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({mode:run.mode,scope:'current model call sum, not real delivery latency; includes failures',rows},null,2));
 const md=[`# 小鲸鱼 ${o.v3?'v2 / v3':'v1 / v2'} 实测记录`,`\n模式：${run.mode}。每请求60秒，最多1次HTTP尝试；每结构阶段最多2次。`, '\n完成不是质量通过；测试收件人，不是真实企微送达。旧报告结果不混进本次计时。'];
 md.push(`\n历史准备：${run.historyMode}。${o.v3?'历史使用替身，不调用模型；只评价本轮生成。':''}\n停止原因：${run.stoppedReason||'无'}\nToken缺失显示未知，已知部分另存metrics.json。`);
 const body=[];
 for(const c of selected){
  const id=`${c.id}-${c.variant}`,rs=rows.filter(r=>r.id===id);
  md.push(`\n## ${id}\n\n此前原话：${c.history.join('\n')||'无'}\n\n本轮原话：${c[c.variant].join('\n\n')}`);
  body.push(`<section><h2>${esc(id)}</h2><h3>此前 / 本轮原话</h3><blockquote>${esc([...c.history,...c[c.variant]].join('\n\n'))}</blockquote>`);
  for(const algorithm of algorithms){
   const r=rs.find(x=>x.algorithm===algorithm),label=labels[algorithm];
   const content=r?.text||r?.result?.error||'未运行';
   const timing=r?.currentAttempted?`${(r.elapsedMs/1000).toFixed(2)}秒`:'未进入本轮生成';
   md.push(`\n### ${label}\n\n状态：${r?.status||'未运行'}；本轮模型 ${timing}；返回Token ${r?.tokens??'未知'}${r?.reused?'；复用结果':''}${r?.result?.phase?'；失败阶段 '+r.result.phase:''}\n\n${content}`);
   body.push(`<article><h3>${label}</h3><p>状态：${esc(r?.status||'未运行')} · 本轮模型 ${esc(timing)} · 返回Token ${r?.tokens??'未知'}${r?.reused?' · 复用':''}${r?.result?.phase?' · 失败阶段 '+esc(r.result.phase):''}</p><blockquote>${esc(content)}</blockquote></article>`);
  }
  body.push(`<p class="review">核对要点：${esc(c.review)}</p><p>评阅待填写：重要事项是否先讲；更正与未定是否准确；必要背景与主语是否清楚；无关版是否改变其他判断。</p></section>`);
  md.push(`\n评阅要点：${c.review}\n\n逐句评阅：待阅读真实答复，不自动打总分。`);
 }
 fs.writeFileSync(path.join(out,'comparison.md'),md.join('\n'));
 fs.writeFileSync(path.join(out,'comparison.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小鲸鱼 ${o.v3?'v2/v3':'v1/v2'} 实测记录</title><style>body{max-width:1060px;margin:32px auto;padding:0 20px;color:#243746;font:16px/1.8 system-ui}header{background:#1f3a5f;color:white;padding:24px}section{border-top:2px solid #d8e3ed;margin:32px 0;padding-top:16px}article{background:#edf3f8;padding:14px 20px;margin:16px 0}blockquote{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;padding:14px;border-left:3px solid #7897b0}.review{font-weight:bold}h2,h3{color:#1f3a5f}button{padding:8px 16px}@media print{button{display:none}article{break-inside:avoid}}</style><header><h1>小鲸鱼 ${o.v3?'v2 / v3':'v1 / v2'} 对照记录</h1><p>${esc(run.mode)} · 已记录${rows.length}/${selected.length*2}个运行单元</p><p>60秒每请求；最多一次HTTP尝试。生成完成不等于质量通过，测试替身确认不等于真实企微送达。</p><p>历史准备：${esc(run.historyMode)}。${o.v3?'历史由替身发送，本次仅评价当前生成。':''}</p><p>停止原因：${esc(run.stoppedReason||'无')}。Token缺失记为未知，不代表零成本。</p></header><button onclick="print()">打印 / 保存PDF</button>${body.join('')}</html>`);
}
save();let stopped=false;
try{
 for(const [index,c] of selected.entries()){
  if(o.v3 && !o.full && c.split==='fresh' && core.some(c=>!run.runs.some(r=>r.id===`${c.id}-${c.variant}` && r.algorithm==='upgraded' && r.result?.status==='completed'))){
   run.stoppedReason='新版核心4个输入未全部生成，暂停新增场景以减少调用；完成也不等于质量通过';process.exitCode=1;break;
  }
  const id=`${c.id}-${c.variant}`;
  // Alternate which algorithm runs first. No claim that this replaces randomized replication.
  for(const algorithm of index%2?[...algorithms].reverse():algorithms){
   const directory=`${id}/${algorithm}`,dest=path.join(out,directory),old=o['resume-from']?path.join(path.resolve(o['resume-from']),directory):null;
   const args=['scripts/experiment-secretary.mjs','--algorithm',algorithm,'--split',c.split,'--case-id',c.id,'--variant',c.variant,'--cases-file',c.file,'--out',dest,'--request-timeout-ms','60000','--request-attempts','1'];
   if(o.v3)args.push('--history-mode','fixture');
   if(o.live)args.push('--live');if(o.config)args.push('--config',path.resolve(o.config));
   if(old && fs.existsSync(path.join(old,'manifest.json')))args.push('--resume-from',old);
   console.log(`\n[${o.v3?'v2/v3':'v1/v2'} ${index+1}/${selected.length}] ${id} ${algorithm}`);
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
