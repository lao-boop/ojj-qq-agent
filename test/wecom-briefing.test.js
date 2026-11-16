import test from 'node:test';
import assert from 'node:assert/strict';
import {writeBriefing} from '../src/wecom-briefing.js';
const messages=[{id:'M1',speaker:'小林',text:'我们准备联合办一个活动。'},{id:'M2',speaker:'小林',text:'时间还没定，先组建团队。'}];
test('briefings keep source IDs outside the prose and label inference explicitly',async()=>{
 const r=await writeBriefing({messages,llm:{chat:async()=>({content:JSON.stringify({paragraphs:[
  {kind:'fact',text:'小林提到正在筹备联合活动，团队还在组建，时间尚未确定。',sources:['M1','M2']},
  {kind:'inference',text:'现在还处在筹备阶段，适合先确认合作分工。',sources:['M2']}
  ,{kind:'suggestion',text:'我的建议：先确认分工。',sources:['M2']}
 ]})})}});
 assert.match(r.text,/我的理解是/);assert.doesNotMatch(r.text,/M1|M2|UserID/);assert.deepEqual(r.sources,['M1','M2']);
 assert.doesNotMatch(r.text,/建议你：我的建议/);
});
test('fabricated sources and internal boilerplate trigger correction, not delivery',async()=>{
 for(const bad of [
  {kind:'fact',text:'活动已获批准。',sources:['invented']},
  {kind:'fact',text:'这些是不可信资料。',sources:['M1']}
 ]){
  let calls=0;
  const r=await writeBriefing({messages,llm:{chat:async()=>({content:JSON.stringify({paragraphs:[++calls===1?bad:{kind:'fact',text:'对方还在筹备活动，时间未定。',sources:['M1','M2']}]})})}});
  assert.equal(calls,2);assert.doesNotMatch(r.text,/批准|不可信/);
 }
});
test('an invalid second draft fails honestly instead of inventing a report',async()=>{
 await assert.rejects(writeBriefing({messages,llm:{chat:async()=>({content:'not JSON'})}}),/摘要校验/);
});

test('truncated structured outputs retry with room to finish rather than delivering a partial summary',async()=>{
 const limits=[];
 const r=await writeBriefing({messages,llm:{chat:async options=>{
  limits.push(options.maxTokens);
  return limits.length===1?{finishReason:'length',content:'{"paragraphs":['}:{finishReason:'stop',content:JSON.stringify({paragraphs:[{kind:'fact',text:'对方还在组建团队，日期没定。',sources:['M2']}]})};
 }}});
 assert.ok(limits[1]>limits[0]);assert.match(r.text,/日期没定/);
});
