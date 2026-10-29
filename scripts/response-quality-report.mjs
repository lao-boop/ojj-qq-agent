import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUALITY_RUBRIC } from './response-quality-cases.mjs';

export function judgeReview(result, review) {
  if(result.status==='service_error')return {status:'service_error',total:null};
  if(!review)return {status:'unreviewed',total:null};
  const scores=Object.keys(QUALITY_RUBRIC.axes).map(k=>review.scores?.[k]);
  if(scores.some(v=>!Number.isInteger(v)||v<0||v>2)||typeof review.rationale!=='string'||!review.rationale.trim())throw new Error(`Invalid review for ${result.id}`);
  const total=scores.reduce((a,b)=>a+b,0);
  return {status:total>=10&&!scores.includes(0)&&!review.critical?'satisfactory':'needs_work',total};
}
export function renderQualityReport(report,reviews={},errata={}){
  const map=new Map(report.results.map(r=>[r.id,r]));
  const items=report.cases.map(original=>{const spec=errata[original.id]?.criteria?{...original,criteria:errata[original.id].criteria}:original;const result=map.get(spec.id),review=reviews[spec.id];return {spec,result,review,...(result?judgeReview(result,review):{status:'unrun',total:null})};});
  const labels={satisfactory:'达到本轮标准',needs_work:'需要改进',service_error:'服务异常，不评分',unreviewed:'待内容复核',unrun:'未运行'};
  const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,items.filter(r=>r.status===k).length]));
  const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const scoreCount=counts.satisfactory+counts.needs_work;
  const cards=items.map(({spec,result,review,status,total})=>`<article data-status="${status}"><h2>${e(spec.id)} <small>${e(spec.category)} · ${labels[status]}${total!==null?` · ${total}/12`:''}</small></h2><details><summary>预先固定的验收要求</summary><ul>${spec.criteria.map(x=>`<li>${e(x)}</li>`).join('')}</ul></details>${(result?.turns||spec.turns).map(t=>`<p class="label">用户输入</p><pre>${e(t.input||t.text)}</pre>${t.reply!==undefined?`<p class="label">实际最终回复</p><pre class="reply">${e(t.reply)}</pre>`:''}`).join('')}${review?`<p><strong>复核依据：</strong>${e(review.rationale)}</p><p>${Object.entries(review.scores).map(([k,v])=>`${e(k)} ${v}/2`).join(' · ')}</p>`:''}${result?.ruleObservations?.length?`<p>规则提示（待复核，非自动判分）：${e(result.ruleObservations.join('；'))}</p>`:''}${(result?.artifacts||[]).map(a=>`<p><a href="${e(a.file)}">下载实际生成文件：${e(a.deliveredName)}</a>${a.pdf?` · <a href="${e(a.pdf)}">渲染PDF</a>`:''}</p>${a.preview?`<a href="${e(a.preview)}"><img src="${e(a.preview)}" alt="实际文件逐页预览" style="max-width:100%;height:auto"></a>`:''}<details><summary>文件内容与结构检查</summary><pre>${e(JSON.stringify(a.inspection,null,2))}</pre></details>`).join('')}${result?.serviceErrors?.length?`<p>服务异常：${e(JSON.stringify(result.serviceErrors))}。该场景出现服务异常，整场未计入内容评分；已获得的回复和文件仍保留。</p>`:''}<label>你的感受：<select data-rating="${e(spec.id)}"><option value="">未评价</option><option>满意</option><option>基本可以</option><option>不满意</option></select></label></article>`).join('');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>回答与交付质量评测</title><style>body{max-width:1100px;margin:30px auto;padding:0 22px;font:16px/1.65 system-ui;color:#172235;background:#f4f7fb}article,section{padding:20px;background:white;border:1px solid #dce3ee;border-radius:10px;margin:18px 0}h1{font-size:28px}h2{font-size:19px}small{font-size:13px;font-weight:normal;color:#5d687a}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f3f7;padding:12px;border-radius:7px;font:inherit}.reply{background:#edf7f2}.label{margin-bottom:2px;font-weight:600}button,select{padding:7px 10px;margin:6px;border:1px solid #bcc9db;border-radius:5px;background:white}a{color:#245baf}</style><h1>回答与交付质量评测</h1><p>${report.cases.length}个测试场景：${report.cases.filter(c=>!c.artifact).length}个文字/多轮场景，${report.cases.filter(c=>c.artifact).length}个真实文件场景。检查最终内容是否有用，区别于上一轮工具路由与参数测试。</p><section><h2>当前结果</h2>${Object.values(errata).map(note=>`<p>评分资料勘误：${e(note.reason)}</p>`).join('')}<p>${Object.entries(counts).map(([k,v])=>`${labels[k]}：${v}`).join(' · ')}</p><p>${scoreCount?`已评分${scoreCount}题，达到标准${counts.satisfactory}题。`:'当前没有可报告的满意度分数。'}服务异常与未复核均不能算通过或内容失败。</p><p>准确、完整、切题、清楚、语气合适、如实说明状态，各0～2分；至少10分且无0分、无关键错误才达标。由Codex按输出证据复核，不是独立用户满意度调查。</p><p>${report.manifest.realMemory?'真实模型、磁盘记忆及重启/期限/用户隔离测试；Office文件真实生成并用LibreOffice渲染。QQ上传回执为本地模拟，没有给真实联系人发送。预览图另经逐页复核，测试小样本不代表全部版式。':'文本模型真实调用，检索为固定样例，记忆在隔离会话内；文件由真实Office生成器制作，无QQ发送。文件结构和内容检查不能证明渲染排版美观。'}</p><a href="results.json">原始结果JSON</a> · <a href="manifest.json">题库、评分与代码哈希</a></section><nav><button data-filter="all">全部</button>${Object.entries(labels).map(([k,v])=>`<button data-filter="${k}">${v}</button>`).join('')}<button id="export">导出我的评价</button></nav>${cards}<script>const key='quality-ratings-${report.manifest.suiteHash}';let ratings={};try{ratings=JSON.parse(localStorage.getItem(key)||'{}')}catch{}document.querySelectorAll('[data-rating]').forEach(s=>{s.value=ratings[s.dataset.rating]||'';s.onchange=()=>{ratings[s.dataset.rating]=s.value;try{localStorage.setItem(key,JSON.stringify(ratings))}catch{}}});document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>document.querySelectorAll('article').forEach(a=>a.hidden=b.dataset.filter!=='all'&&a.dataset.status!==b.dataset.filter));document.querySelector('#export').onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(ratings,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='my-quality-ratings.json';a.click();URL.revokeObjectURL(u)};</script></html>`;
  return {html,summary:{counts,reviewed:scoreCount,satisfactoryRate:scoreCount?counts.satisfactory/scoreCount:null}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const dir=path.resolve(process.argv[2]||'tmp/response-quality-run');
  const report=JSON.parse(fs.readFileSync(path.join(dir,'results.json'),'utf8'));
  const reviewPath=path.join(dir,'reviews.json');
  const reviews=fs.existsSync(reviewPath)?JSON.parse(fs.readFileSync(reviewPath,'utf8')):{};
  const errataPath=path.join(dir,'review-errata.json');
  const errata=fs.existsSync(errataPath)?JSON.parse(fs.readFileSync(errataPath,'utf8')):{};
  const {html,summary}=renderQualityReport(report,reviews,errata);
  fs.writeFileSync(path.join(dir,'report.html'),html);fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));console.log(path.join(dir,'report.html'));
}
