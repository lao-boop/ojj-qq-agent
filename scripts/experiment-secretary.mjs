// Synthetic employees, real scheduled briefing path, no WeCom connection.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { wiringResponse } from '../experiments/secretary/wiring-double.js';
import { writeBriefing as baselineWriter } from '../experiments/secretary/baseline-briefing.js';
import { writeScheduledBriefing as previousWriter } from '../experiments/secretary/previous-scheduled-briefing.js';
import {writeScheduledBriefing as v3Writer} from '../experiments/secretary/v3-scheduled-briefing.js';
import {legacyMaterial} from '../experiments/secretary/legacy-context-v3.js';
import { writeScheduledBriefing as v2Writer } from '../experiments/secretary/v2-scheduled-briefing.js';
import { requestFailure, expectAckLoss, checkResume, reuseCompleted } from '../experiments/secretary/support.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const { values: opts } = parseArgs({ options: { live: {type:'boolean'}, algorithm:{type:'string',default:'upgraded'}, split:{type:'string',default:'dev'}, out:{type:'string'}, config:{type:'string'}, 'resume-from':{type:'string'}, 'request-timeout-ms':{type:'string',default:'180000'}, 'request-attempts':{type:'string'}, 'cases-file':{type:'string',default:'experiments/secretary/cases.json'}, 'case-id':{type:'string'}, variant:{type:'string'}, 'history-mode':{type:'string',default:'model'} } });
assert.ok(['dev','holdout','fresh'].includes(opts.split));
assert.ok(['baseline','previous','v2','v3','upgraded'].includes(opts.algorithm));
assert.ok(['model','fixture'].includes(opts['history-mode']));
const requestTimeoutMs=Number(opts['request-timeout-ms']);
assert.ok(Number.isInteger(requestTimeoutMs) && requestTimeoutMs>=1000 && requestTimeoutMs<=300000);
const requestAttempts=opts['request-attempts']===undefined?null:Number(opts['request-attempts']);
assert.ok(requestAttempts===null || (Number.isInteger(requestAttempts) && requestAttempts>=1 && requestAttempts<=3));
if(opts.variant)assert.ok(['original','key','irrelevant'].includes(opts.variant));
const out = path.resolve(opts.out || path.join(root, 'tmp', `secretary-${opts.live?'live':'wiring'}-${opts.split}-${Date.now()}`));
fs.mkdirSync(out, {recursive:true});
assert.ok(!fs.existsSync(path.join(out,'manifest.json')), 'Use a new output directory; baseline must not be overwritten');
const configuredPath = opts.config || process.env.QQBOT_CONFIG || path.join(root,'config.json');
const configured = fs.existsSync(configuredPath) ? JSON.parse(fs.readFileSync(configuredPath)).llm || {} : {};
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'secretary-experiment-'));
process.env.QQBOT_DATA = path.join(temp,'data');
process.env.QQBOT_CONFIG = path.join(temp,'config.json');
const { DEFAULTS, deepMerge } = await import('../src/config.js');
const { createWecomApp } = await import('../src/wecom-main.js');
const modelCfg = {...DEFAULTS.llm,...configured};
modelCfg.apiKey = process.env.DEEPSEEK_API_KEY || modelCfg.apiKey;
modelCfg.baseUrl = process.env.DEEPSEEK_BASE_URL || modelCfg.baseUrl;
if (opts.live && !modelCfg.apiKey) {
  fs.rmSync(temp,{recursive:true,force:true});
  throw new Error('No model key: use --env-file with the existing runtime .env, or --config. No real answers obtained.');
}
const caseFile=path.resolve(root,opts['cases-file']);
const all = JSON.parse(fs.readFileSync(caseFile));
const cases = all.filter(c=>c.split===opts.split && (!opts['case-id'] || c.id===opts['case-id']));
assert.ok(cases.length,'No matching cases');
const sha = file => createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
assert.equal(sha('experiments/secretary/v2-scheduled-briefing.js'),'700bf4755787cfb34fbe238380fca8c03bec343ca6fb7d61ff66764823a8070b','Frozen v2 must remain byte-identical to 1df1a18');
assert.equal(sha('experiments/secretary/previous-scheduled-briefing.js'),'32f2809bda0f6567c610c9e1039ca760f1e6df873c7b61356fce47f1ba2882e3','Frozen v1 must remain byte-identical to 4fc65d1');
assert.equal(sha('experiments/secretary/baseline-briefing.js'),'393e10fa4ee9fdaf6f80906dbe5d48a5d50727da5e65e07b9afa9da351286923','Baseline must remain byte-identical to cf06a720');
const manifest = {mode:opts.live?'real-model':'wiring-only, NOT model answers', algorithm:opts.algorithm, baselineCommit:'cf06a72084811d84cb8388c1bbf2a549e20b2f22', split:opts.split, model:opts.live?modelCfg.model:null, started:new Date().toISOString(), files:Object.fromEntries(['src/wecom-secretary.js','src/wecom-briefing.js','src/wecom-scheduled-briefing.js','experiments/secretary/baseline-briefing.js','scripts/experiment-secretary.mjs','experiments/secretary/cases.json'].map(f=>[f,sha(f)])),results:[]};
manifest.requestTimeoutMs=requestTimeoutMs;manifest.historyMode=opts['history-mode'];
manifest.files['experiments/secretary/v2-scheduled-briefing.js']=sha('experiments/secretary/v2-scheduled-briefing.js');
manifest.files['experiments/secretary/v3-scheduled-briefing.js']=sha('experiments/secretary/v3-scheduled-briefing.js');
manifest.files['experiments/secretary/legacy-context-v3.js']=sha('experiments/secretary/legacy-context-v3.js');
manifest.requestAttempts=requestAttempts;
manifest.caseHash=createHash('sha256').update(fs.readFileSync(caseFile)).digest('hex');
manifest.caseSelection=opts['case-id'] || null;manifest.variantSelection=opts.variant || null;
manifest.previousCommit='4fc65d1e0edad4cf63a03156bf40e7b0fa7d6700';
manifest.files['experiments/secretary/previous-scheduled-briefing.js']=sha('experiments/secretary/previous-scheduled-briefing.js');
manifest.modelOrigin=opts.live?new URL(modelCfg.baseUrl).origin:null;
manifest.proxyEnvironmentPresent=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].some(k=>Boolean(process.env[k]));
const save = () => fs.writeFileSync(path.join(out,'manifest.json'), JSON.stringify(manifest,null,2));
try {
const resumeDir=opts['resume-from']?path.resolve(opts['resume-from']):null;
const previous=resumeDir?JSON.parse(fs.readFileSync(path.join(resumeDir,'manifest.json'),'utf8')):null;
if(previous) {
  checkResume(previous,manifest);
  manifest.resumedFrom=resumeDir;
  manifest.resumeEndpointVerified=Boolean(previous.modelOrigin);
  fs.copyFileSync(path.join(resumeDir,'manifest.json'),path.join(out,'previous-manifest.json'));
}
save();
let stopReason=null;
for (const c of cases) for (const variant of (opts.variant?[opts.variant]:['original','key','irrelevant'])) {
  const id = `${c.id}-${variant}`;
  if(reuseCompleted(previous,resumeDir,out,id)) {
    manifest.results.push({id,status:'completed',reusedFrom:resumeDir});save();
    console.log(`[${opts.algorithm}/${opts.split}] ${id}: 复用已保存结果，不调用模型`);continue;
  }
  if(stopReason) {manifest.results.push({id,status:'not-run',error:stopReason});save();continue;}
  console.log(`[${opts.algorithm}/${opts.split}] ${id} (${manifest.mode})`);
  const cfg = deepMerge(structuredClone(DEFAULTS), {llm:modelCfg, wecom:{botId:`experiment-${id}`,mode:'whitelist',userAllow:['employee','HuangZiMing'],groupAllow:[],contacts:[{userId:'employee',name:'小林'}],secretary:{enabled:true,ownerUserId:'HuangZiMing',intervalMinutes:60}}, chat:{rateLimit:{perChatPerMinute:0}}, log:{level:'error',file:false}});
  const app = createWecomApp({cfg});
  // Construction only. Never app.start(): no network transport, timer or console.
  app.transport.connect = () => { throw new Error('Experiment must not connect to WeCom'); };
  app.runtime.sender = {async replyText(){return true;},async sendResult(){}};
  app.runtime.brain = {async respond(){return {bubbles:['测试接收']};}};
  const s = app.secretary;
  if (opts.algorithm === 'baseline') s.scheduledWriter = baselineWriter;
  if (opts.algorithm === 'previous') s.scheduledWriter = previousWriter;
  if (opts.algorithm === 'v2') s.scheduledWriter = v2Writer;
  if (opts.algorithm === 'v3') s.scheduledWriter=v3Writer;
  if (['baseline','previous','v2','v3'].includes(opts.algorithm)) s.briefingMaterial=legacyMaterial;
  let now = Date.now(), seq = 0, stage = 'history', phase='receive';
  let failure=null;
  s.now = () => now;
  s.running = true;
  const calls = [], deliveries = [];
  const real = s.llm;
  s.llm = {async chat(options) {
    // Applies equally to both algorithms, only inside this isolated experiment.
    const input = structuredClone({...options,timeoutMs:requestTimeoutMs,...(requestAttempts===null?{}:{maxAttempts:requestAttempts})});
    const call = {stage,input,startedAt:new Date().toISOString(),attempts:0};
    calls.push(call);
    const checkpoint = () => fs.writeFileSync(path.join(out,`${id}-calls.json`),JSON.stringify(calls,null,2));
    checkpoint();
    let response; const started = Date.now(), priorFailures=real.stats.failures;
    console.log(`  ${stage}/${JSON.parse(input.messages[1].content).stage || 'single'}: 请求模型（单次上限${requestTimeoutMs/1000}秒）`);
    try { response = opts.live ? await real.chat(input) : wiringResponse(input,'测试替身仅确认摘要接口通路，不代表模型转告。'); }
    catch(error) {
      call.attemptDetails=error.modelAttempts || [];
      call.errorDetails=requestFailure(error);call.error=call.errorDetails.message;
      call.elapsedMs=Date.now()-started;call.attempts=real.stats.failures-priorFailures;
      checkpoint();error.experimentRequestError=call.errorDetails;throw error;
    }
    // Keep final content and token counts; do not export provider reasoning text.
    call.response={...response,message:response.message?Object.fromEntries(Object.entries(response.message).filter(([key])=>key!=='reasoning_content' && key!=='reasoning')):response.message};
    call.attemptDetails=response.attempts || [];
    call.elapsedMs=Date.now()-started;
    call.attempts=opts.live?real.stats.failures-priorFailures+1:0;
    checkpoint();
    return response;
  }};
  let failAck = false;
  const ackLost=new Error('Synthetic ACK lost');
  s.sender = {async sendText(frame,text) {
    assert.equal(frame.body.chattype,'single');
    assert.equal(frame.body.from.userid,'HuangZiMing');
    if(failAck) { failAck=false; throw ackLost; }
    deliveries.push({stage,origin:stage==='history' && opts['history-mode']==='fixture'?'fixture-history':manifest.mode,recipient:'TEST DOUBLE (HuangZiMing)',text});
  }};
  const receive = async (text,user='employee') => {
    const msgid = `${id}-${++seq}`;
    await app.runtime.handle({headers:{req_id:msgid},body:{aibotid:cfg.wecom.botId,msgid,chattype:'single',from:{userid:user},msgtype:'text',text:{content:text}}});
  };
  const due = async () => {now=Math.max(now,s.state.nextAt); await s.tick();};
  try {
    await receive('拒绝访问的消息','outsider');
    assert.equal(s.records.length,0);
    await receive('负责人自己的消息','HuangZiMing');
    await due(); assert.equal(calls.length,0); assert.equal(deliveries.length,0);
    for(const text of c.history) await receive(text);
    phase='history-generation';
    if(c.history.length) {
      const writer=s.scheduledWriter;
      if(opts['history-mode']==='fixture')s.scheduledWriter=async({messages})=>({text:'测试准备：历史原话已归档；此句是替身，不是模型答复。',sources:messages.filter(m=>!m.contextOnly).map(m=>m.id)});
      try {await due();} finally {s.scheduledWriter=writer;}
    }
    stage='current';
    for(const text of c[variant]) await receive(text);
    const before=calls.length;
    await s.tick(); assert.equal(calls.length,before, 'No early hourly briefing');
    const cursor=s.state.cursor;
    failAck=true;
    phase='current-generation';
    await expectAckLoss(due,ackLost);
    phase='delivery-retry';
    assert.equal(s.state.cursor,cursor,'No cursor advance before ACK');
    assert.ok(s.state.outbox);
    const generated=calls.length;
    await s.tick(); assert.equal(calls.length,generated,'Retry must reuse generated text');
    assert.equal(s.state.outbox,null);
    assert.equal(s.state.cursor,s.records.length);
    const delivered=deliveries.length;
    await due(); assert.equal(deliveries.length,delivered,'No repeat with no new employee messages');
    phase='evidence-checks';
    const input=JSON.parse(calls.find(x=>x.stage==='current').input.messages[1].content).messages;
    for(const text of c[variant]) assert.ok(input.some(m=>!m.contextOnly && m.text===text));
    for(const text of c.history) assert.ok(input.some(m=>m.contextOnly && m.text===text),'Previous round source must be included as context');
    for(const source of s.state.latestSources) assert.ok(s.byId.has(source));
    manifest.results.push({id,status:'completed'}); save();
  } catch(e) {
    failure={id,status:'failed',phase,kind:e.experimentRequestError?.kind || (e.code==='ERR_ASSERTION'?'pipeline':'validation'),error:e.experimentRequestError?.message || e.message};
    manifest.results.push(failure);
    console.error(`  失败 ${phase}: ${failure.error}`);
    if(e.experimentRequestError) {
      stopReason='模型请求失败，暂停余下场景；恢复连接后从本目录续跑';
      manifest.stoppedReason=stopReason;process.exitCode=2;
      console.error(JSON.stringify(e.experimentRequestError));
    } else process.exitCode ||= 1;
    save();
  }
  finally {
    const result={id,status:failure?'failed':'completed',failure,mode:manifest.mode,history:c.history,employee:c[variant],deliveries,callsFile:`${id}-calls.json`,sources:s.state.latestSources || [],review:c.review,checks:failure?'incomplete':'archive/access/hourly/context/ACK retry/no duplicate passed'};
    fs.writeFileSync(path.join(out,`${id}.json`),JSON.stringify(result,null,2));
    if(fs.existsSync(s.archiveFile))fs.copyFileSync(s.archiveFile,path.join(out,`${id}-archive.jsonl`));
    app.stop();
  }
}
fs.writeFileSync(path.join(out,'review.md'), '# '+manifest.mode+' / '+opts.algorithm+'\n\n'+manifest.results.map(({id,status,error})=>{
 if(status!=='completed') return `## ${id}\n\n未生成有效结果：${error}\n`;
 const r=JSON.parse(fs.readFileSync(path.join(out,`${id}.json`)));
 return `## ${id}\n\n此前原话：${r.history.join('\n') || '无'}\n\n本轮原话：\n${r.employee.join('\n\n')}\n\n实际转告（${manifest.mode}）：\n${r.deliveries.filter(d=>d.stage==='current').map(d=>d.text).join('\n\n')}\n\n人工逐句核对：${r.review}\n\n- 重要的先讲：待评（引用输出原句）\n- 更正与不确定性：待评（引用输出原句）\n- 一遍听懂：待评（指出具体歧义或赘述）\n- 与同组另外两版比较：关键事实是否改变，无关细节是否干扰：待评\n`;
}).join('\n'));
console.log(`${manifest.results.filter(r=>r.status==='completed').length}/${manifest.results.length} variants completed; ${manifest.mode}; ${out}`);
} finally {fs.rmSync(temp,{recursive:true,force:true});}
