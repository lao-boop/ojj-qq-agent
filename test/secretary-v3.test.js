import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {validateDirectBriefing,writeScheduledBriefing} from '../src/wecom-scheduled-briefing.js';
import {wiringResponse} from '../experiments/secretary/wiring-double.js';
import {checkResume} from '../experiments/secretary/support.js';
const messages=[{id:'old',contextOnly:true,text:'下周一客户验收，小周负责演示。'},{id:'new',contextOnly:false,text:'小周能否回来还没定，小林下班前找小何确认能否替班。'}];
const sample=()=>({paragraphs:[{text:'周一验收的演示人员还没定，小林下班前找小何确认能否替班。',evidence:messages.map(m=>({source:m.id,quote:m.text}))}]});
const reply=x=>({content:JSON.stringify(x),finishReason:'stop'});

test('direct writer normally uses one request and allows concise paraphrased context',async()=>{
 const calls=[];
 const r=await writeScheduledBriefing({messages,llm:{async chat(o){calls.push(structuredClone(o));return reply(sample());}}});
 assert.equal(calls.length,1);assert.deepEqual(r.sources,['old','new']);
 assert.equal(calls[0].maxAttempts,1);assert.equal(calls[0].timeoutMs,60000);
 assert.deepEqual(JSON.parse(calls[0].messages[1].content),{stage:'direct',messages});
 assert.equal(r.text,sample().paragraphs[0].text);assert.ok(!r.text.includes(messages[0].text));
});
test('rejects fabricated quotes, unknown sources, history-only paragraphs and omitted new messages',()=>{
 for(const evidence of [[{source:'new',quote:'已经确定'}],[{source:'unknown',quote:'还没定'}],[{source:'old',quote:messages[0].text}]]){
  const raw=sample();raw.paragraphs[0].evidence=evidence;assert.throws(()=>validateDirectBriefing(raw,messages));
 }
 assert.throws(()=>validateDirectBriefing(sample(),[...messages,{id:'new2',text:'合同已经签署。'}]),/遗漏/);
 for(const raw of [null,{paragraphs:[null]},{paragraphs:[]},{paragraphs:[{text:'x'.repeat(221)}]}])assert.throws(()=>validateDirectBriefing(raw,messages));
});
test('structural retry retains originals; repeated invalid output never falls back to unchecked prose',async()=>{
 const calls=[];
 const r=await writeScheduledBriefing({messages,llm:{async chat(o){calls.push(structuredClone(o));return calls.length===1?reply({paragraphs:[]}):reply(sample());}}});
 assert.equal(r.text,sample().paragraphs[0].text);assert.equal(calls.length,2);
 assert.deepEqual(JSON.parse(calls[1].messages[1].content).messages,messages);
 assert.match(calls[1].messages.at(-1).content,/修正/);
 let n=0;await assert.rejects(writeScheduledBriefing({messages,llm:{async chat(){n++;return reply({paragraphs:[]});}}}),/direct校验未通过/);assert.equal(n,2);
});
test('transport failure does not trigger an inline retry; cancellation does not return stale prose',async()=>{
 let n=0;const error=new Error('transport failed');
 await assert.rejects(writeScheduledBriefing({messages,llm:{async chat(){n++;throw error;}}}),e=>e===error);assert.equal(n,1);
 let current=true;assert.equal(await writeScheduledBriefing({messages,isCurrent:()=>current,llm:{async chat(){current=false;return reply(sample());}}}),null);
 assert.equal(await writeScheduledBriefing({messages,isCurrent:()=>false,llm:{async chat(){assert.fail();}}}),null);
 assert.deepEqual((await writeScheduledBriefing({messages:[messages[0]],llm:{async chat(){assert.fail();}}})).sources,[]);
});
test('source substring validation is explicitly NOT a semantic factuality check',()=>{
 const raw=sample();raw.paragraphs[0].text='小何已经确认替班。';
 assert.doesNotThrow(()=>validateDirectBriefing(raw,messages));
 // Deliberately false prose passes structural checks: quality requires real-output review.
});
test('resume refuses mixing model-generated and fixture-generated history',()=>{
 assert.throws(()=>checkResume({historyMode:'model'},{historyMode:'fixture'}),/historyMode/);
});

test('paired runner stops fresh paid requests after a failed v3 core, with fixture history and honest token accounting',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'secretary-v3-gate-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 let direct=0,all=0;
 const server=http.createServer(async(req,res)=>{
  let data='';for await(const chunk of req)data+=chunk;
  const input=JSON.parse(data);all++;
  const stage=JSON.parse(input.messages[1].content).stage;
  if(stage==='direct')direct++;
  // Fail every v3 direct response structurally, while frozen v2 completes.
  const content=stage==='direct'?'{}':wiringResponse(input,'仅验证测试流程，不是模型答复。').content;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const config=path.join(tmp,'config.json'),out=path.join(tmp,'results');
 fs.writeFileSync(config,JSON.stringify({llm:{apiKey:'test-only',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'local-test'}}));
 const env={...process.env};for(const key of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[key];
 const child=spawn(process.execPath,['scripts/iterate-secretary.mjs','--v3','--live','--config',config,'--out',out],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:'pipe'});
 let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 const [code]=await once(child,'close');assert.equal(code,1,log);
 const run=JSON.parse(fs.readFileSync(path.join(out,'iteration.json')));
 assert.equal(run.runs.length,8);assert.match(run.stoppedReason,/暂停新增场景/);
 assert.equal(direct,8);assert.equal(all,16);
 for(const row of run.runs){
  const dir=path.join(out,row.directory);
  const calls=JSON.parse(fs.readFileSync(path.join(dir,row.id+'-calls.json')));assert.ok(calls.every(c=>c.stage==='current'));
  const r=JSON.parse(fs.readFileSync(path.join(dir,row.id+'.json')));
  assert.ok(r.deliveries.filter(d=>d.stage==='history').every(d=>d.origin==='fixture-history'));
 }
 const metrics=JSON.parse(fs.readFileSync(path.join(out,'metrics.json')));
 assert.ok(metrics.rows.every(r=>r.tokens===null));
});
