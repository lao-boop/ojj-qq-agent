import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import {LLM} from '../src/llm.js';
import {validateEvidencePlan,validateScheduledProse,writeScheduledBriefing} from '../experiments/secretary/v2-scheduled-briefing.js';

// Authored fixtures exercise guards and request policy, not real-model understanding.
const messages=[
  {id:'old',contextOnly:true,text:'下周一客户验收，小周说能来负责演示。'},
  {id:'new',contextOnly:false,text:'小周周一要去医院，能不能回来还不知道；我今天下班前问小何能不能替一下，还没定。'},
];
const plan=()=>({importance:'substantive',items:[{id:'I1',topic:'演示人员变化',priority:'lead',context:[{source:'old',quote:'下周一客户验收'}],facts:[{id:'F1',status:'uncertain',evidence:[{source:'new',quote:messages[1].text}]}],updates:[]}]});
const prose=text=>({paragraphs:[{text,facts:['F1']}]});
const reply=x=>({content:JSON.stringify(x),finishReason:'stop'});
const good='下周一客户验收，小周能否回来还不知道；小林今天下班前问小何能不能替一下，还没定。';

test('selected necessary context must appear in its own paragraph and is traceable',()=>{
 const p=validateEvidencePlan(plan(),messages);
 assert.deepEqual(validateScheduledProse(prose(good),p).sources,['new','old']);
 assert.throws(()=>validateScheduledProse(prose('小周能否回来还不知道，小何能不能替也没定。'),p),/必要业务背景/);
 const other={id:'I2',topic:'例行',priority:'normal',context:[],facts:[{id:'F2',status:'reported',evidence:[{source:'new',quote:'还没定'}]}],updates:[]};
 p.items.push(other);
 assert.throws(()=>validateScheduledProse({paragraphs:[{text:'小周能否回来还不知道。',facts:['F1']},{text:'下周一客户验收。',facts:['F2']}]},p),/必要业务背景/);
});

test('context is bounded and must quote an actual supplied historical message',()=>{
 for(const context of [undefined,[{source:'missing',quote:'下周一客户验收'}],[{source:'old',quote:'下周一验收取消'}],[{source:'new',quote:'还没定'}],[{source:'old',quote:'x'.repeat(81)}]]){
  const p=plan();p.items[0].context=context;assert.throws(()=>validateEvidencePlan(p,messages));
 }
});

test('compact plan passes only checked quotes and states, not redundant paraphrases',()=>{
 const p=plan();p.items[0].reason='未证实的猜想';p.items[0].facts[0].text='客户资金紧张';
 const checked=validateEvidencePlan(p,messages);
 assert.equal(checked.items[0].reason,undefined);assert.equal(checked.items[0].facts[0].text,undefined);
 assert.deepEqual(checked.items[0].facts[0].evidence,p.items[0].facts[0].evidence);
});

test('missing selected context retries composition only, retaining original evidence',async()=>{
 const calls=[];
 const r=await writeScheduledBriefing({messages,llm:{async chat(o){
  calls.push(o);assert.equal(o.timeoutMs,60000);assert.equal(o.maxAttempts,1);
  const input=JSON.parse(o.messages[1].content);assert.deepEqual(input.messages,messages);
  return reply(input.stage==='evidence'?plan():prose(calls.length===2?'小周能否回来还不知道。':good));
 }}});
 assert.equal(r.text,good);assert.deepEqual(calls.map(c=>JSON.parse(c.messages[1].content).stage),['evidence','compose','compose']);
 assert.match(calls[2].messages.at(-1).content,/必要业务背景/);
});

test('repeated context omission fails closed instead of returning a shorter incomplete report',async()=>{
 let calls=0;
 await assert.rejects(writeScheduledBriefing({messages,llm:{async chat(o){calls++;return reply(JSON.parse(o.messages[1].content).stage==='evidence'?plan():prose('替补还没定。'));}}}),/compose校验未通过/);
 assert.equal(calls,3);
});

test('routine reports may omit incidental detail while retaining the source',()=>{
 const ms=[{id:'n',text:'合同都归档了，客户确认收到了，文件夹换成灰色，明天照旧。',contextOnly:false}];
 const p=validateEvidencePlan({importance:'substantive',items:[{id:'I',topic:'正常进展',priority:'normal',context:[],updates:[],facts:[{id:'F',status:'reported',evidence:[{source:'n',quote:ms[0].text}]}]}]},ms);
 assert.equal(validateScheduledProse({paragraphs:[{text:'合同已归档，客户确认收到。明天照旧。',facts:['F']}]},p).text,'合同已归档，客户确认收到。明天照旧。');
});

test('guard limitation is explicit: an empty model-selected context is not semantic proof',()=>{
 const p=plan();p.items[0].context=[];
 assert.doesNotThrow(()=>validateScheduledProse(prose('小周能否回来还不知道。'),validateEvidencePlan(p,messages)));
});

const regressions=JSON.parse(fs.readFileSync(new URL('./fixtures/secretary-context-regressions.json',import.meta.url)));
for(const sample of regressions)test(`real v1 prose with analyst-labelled context: ${sample.id}`,()=>{
 const annotated=structuredClone(sample.plan);
 for(const item of annotated.items)item.context=[];
 // The annotation is explicit. This does not pretend the new model selected the background.
 annotated.items.find(i=>i.priority==='lead').context=[sample.requiredContext];
 const checked=validateEvidencePlan(annotated,sample.messages);
 if(sample.shouldPass){
  const result=validateScheduledProse(sample.prose,checked);assert.ok(result.sources.includes(sample.requiredContext.source));
 }else assert.throws(()=>validateScheduledProse(sample.prose,checked),/必要业务背景/);
});

async function serverFor(t,handler){
 const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');
 t.after(()=>{s.closeAllConnections();s.close();});
 return new LLM({baseUrl:`http://127.0.0.1:${s.address().port}`,apiKey:'test-only',model:'test',timeoutMs:1000,maxTokens:100,temperature:.1},{debug(){},warn(){}});
}
test('scheduled transport makes one attempt; failure telemetry contains no echoed secrets',async t=>{
 let calls=0;const llm=await serverFor(t,(_,res)=>{calls++;res.writeHead(503);res.end('private-test-token');});
 await assert.rejects(llm.chat({messages:[],maxAttempts:1}),e=>{
  assert.equal(e.modelAttempts.length,1);assert.equal(e.modelAttempts[0].status,503);assert.doesNotMatch(JSON.stringify(e.modelAttempts),/private/);return true;
 });assert.equal(calls,1);
});
test('ordinary callers retain default retries; successful telemetry accounts for both attempts',async t=>{
 let calls=0;const llm=await serverFor(t,(_,res)=>{
  if(++calls===1){res.writeHead(503);res.end('transient');return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{total_tokens:2}}));
 });
 const r=await llm.chat({messages:[]});assert.equal(calls,2);assert.deepEqual(r.attempts.map(a=>a.ok),[false,true]);assert.equal(r.content,'ok');
});
test('attempt limit is validated before any HTTP request',async t=>{
 let calls=0;const llm=await serverFor(t,(_,res)=>{calls++;res.end('{}');});
 for(const maxAttempts of [0,4,1.5])await assert.rejects(llm.chat({messages:[],maxAttempts}),/attempt limit/);
 assert.equal(calls,0);
});
test('timeout has one recorded attempt under the scheduled policy',async t=>{
 let calls=0;const llm=await serverFor(t,()=>{calls++;});
 await assert.rejects(llm.chat({messages:[],maxAttempts:1,timeoutMs:40}),e=>{
  assert.equal(e.name,'TimeoutError');assert.equal(e.modelAttempts.length,1);return true;
 });assert.equal(calls,1);
});
