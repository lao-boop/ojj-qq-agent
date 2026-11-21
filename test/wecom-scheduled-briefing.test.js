import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEvidencePlan, validateScheduledProse, writeScheduledBriefing} from '../src/wecom-scheduled-briefing.js';

// Hand-authored responses test guards, NOT a model's comprehension or summary quality.
const messages = [
  {id:'M0',text:'本次合同原定明天签。',contextOnly:true},
  {id:'M1',text:'展会来了三十拨人。',contextOnly:false},
  {id:'M2',text:'刚确认本次合同已签。按月付问的是明年。',contextOnly:false},
];
const fact = (id,text,status,source,quote) => ({id,text,status,evidence:[{source,quote}]});
function plan() { return {importance:'substantive',items:[
  {id:'I1',topic:'展会',priority:'normal',context:[],updates:[],facts:[fact('F1','展会三十拨人','reported','M1',messages[1].text)]},
  {id:'I2',topic:'本次续约',priority:'lead',context:[],updates:[{oldFact:'F0',newFact:'F2'}],facts:[
    fact('F0','本次合同原定明天签','superseded','M0',messages[0].text),
    fact('F2','员工确认本次合同已签，按月付问的是明年','confirmed','M2',messages[2].text),
  ]},
]}; }
const prose = () => ({paragraphs:[{text:'员工刚确认本次合同已签，按月付问的是明年。展会来了三十拨人。',facts:['F2','F1']}]});
const response = value => ({content:JSON.stringify(value)});

test('evidence plan orders the lead and correction receipts retain both original sources', () => {
  const checked = validateEvidencePlan(plan(), messages);
  assert.equal(checked.items[0].id,'I2');
  const result = validateScheduledProse(prose(),checked);
  assert.deepEqual(result.sources,['M2','M0','M1']);
  assert.doesNotMatch(result.text,/M0|F2|confirmed/);
});

test('invented quotes, missing new records, duplicate facts and cross-issue replacements are rejected', () => {
  const mutations = [
    p=>p.items[1].facts[1].evidence[0].quote='客户资金紧张',
    p=>p.items[1].facts[1].evidence[0].source='unseen',
    p=>p.items.shift(),
    p=>p.items[1].facts[1].id='F1',
    p=>p.items[1].updates[0].newFact='F1',
    p=>p.items[1].updates=[],
  ];
  for (const mutate of mutations) { const p=plan(); mutate(p); assert.throws(()=>validateEvidencePlan(p,messages)); }
});

test('history alone cannot become a new report item', () => {
  const p=plan(); p.items.push({id:'I3',topic:'历史',priority:'normal',context:[],updates:[],facts:[fact('F3','原定明天','planned','M0',messages[0].text)]});
  assert.throws(()=>validateEvidencePlan(p,messages),/历史背景/);
});

test('superseded references, omission of lead, and routine-first references trigger rejection', () => {
  const p=validateEvidencePlan(plan(),messages);
  for(const ids of [['F0'],['F1'],['unknown'],['F1','F2']]) {
    assert.throws(()=>validateScheduledProse({paragraphs:[{text:'测试',facts:ids}]},p));
  }
  assert.throws(()=>validateScheduledProse({error:'发现更正遗漏'},p),/冲突/);
});

test('scheduled writer keeps all originals in both stages and only retries the invalid stage',async()=>{
  const calls=[];
  const r=await writeScheduledBriefing({messages,llm:{async chat(options){
    const input=JSON.parse(options.messages[1].content);calls.push(input);
    assert.deepEqual(input.messages,messages);
    if(input.stage==='evidence') return response(plan());
    return response(calls.length===2?{paragraphs:[{text:'仍未签',facts:['F0']}]}:prose());
  }}});
  assert.deepEqual(calls.map(x=>x.stage),['evidence','compose','compose']);
  assert.equal(calls[1].plan.items[0].id,'I2');
  assert.match(r.text,/合同已签/);
});

test('failed extraction cannot send or fall back to an unvalidated one-pass report',async()=>{
  let calls=0;
  await assert.rejects(writeScheduledBriefing({messages,llm:{async chat(){calls++;const p=plan();p.items[0].facts[0].evidence[0].quote='不存在的原话';return response(p);}}}),/evidence校验/);
  assert.equal(calls,2);
});

test('recipient change during evidence generation prevents the next model call',async()=>{
  let current=true,calls=0;
  const r=await writeScheduledBriefing({messages,isCurrent:()=>current,llm:{async chat(){calls++;current=false;return response(plan());}}});
  assert.equal(r,null);assert.equal(calls,1);
});

test('context-only input makes no model call; malformed or truncated extraction retries',async()=>{
  let calls=0;
  await writeScheduledBriefing({messages:messages.slice(0,1),llm:{async chat(){calls++;}}});
  assert.equal(calls,0);
  const limits=[];
  await writeScheduledBriefing({messages,llm:{async chat(options){
    limits.push(options.maxTokens);calls++;
    if(calls===1)return {finishReason:'length',content:'{"items":['};
    return response(calls===2?plan():prose());
  }}});
  assert.ok(limits[1]>limits[0]);assert.equal(calls,3);
});

test('source existence is not semantic entailment: guards deliberately do not claim to detect it',()=>{
  const p=plan();p.items[1].facts[1].status='planned';
  // Valid source IDs and literal quotes cannot prove this claim. Live review must catch it.
  assert.doesNotThrow(()=>validateEvidencePlan(p,messages));
});
