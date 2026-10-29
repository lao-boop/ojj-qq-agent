import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, verifyNumbers } from '../src/numbers.js';
import { createTools } from '../src/tools.js';
import { DEFAULTS } from '../src/config.js';
import { AgentManager } from '../src/agents/manager.js';
import { normalizeInput } from '../src/agents/intent.js';

test('decimal arithmetic stays exact across precedence, signs, percentage and rounding', () => {
  for (const [expression, expected] of [['0.1+0.2','0.3'],['(48.35*6-17.2)/2','136.45'],['-2*(-3+1)','4'],['360*87.5%','315'],['100-12/4*2','94']]) assert.equal(calculate(expression).result, expected);
  assert.deepEqual(calculate('2/3', 2), {expression:'2/3',result:'0.67',exact:'2/3',rounded:true});
  assert.equal(calculate('-1.005',2).result,'-1.01');
  for (let cents=1;cents<100;cents+=7) assert.equal(calculate(`(${cents}/100)*3-(${cents}/100)*2`).exact,calculate(`${cents}/100`).exact);
});

test('calculator rejects code, division by zero, malformed and unbounded expressions', () => {
  for (const expression of ['globalThis.secret=1','process.env.KEY','1;2','2**100000','2(3)','1/0','1..2','1 2','('.repeat(30)+'1'+')'.repeat(30),'9'.repeat(100),'1+'.repeat(260)+'1']) assert.throws(()=>calculate(expression));
  assert.throws(()=>calculate('1/2',-1)); assert.throws(()=>calculate(1));
});

const decision = {constraints:[{field:'total',operator:'<=',value:'600'},{field:'offline',operator:'==',value:true}],options:[
  {label:'at-limit',values:{total:'580+20',offline:true}},
  {label:'over',values:{total:'600.01',offline:true}},
  {label:'unknown',values:{total:'590',offline:null}},
  {label:'unsupported',values:{total:'500',offline:false}},
]};
test('hard constraints include equal boundary, total cost, exact decimals, false and unknown', () => {
  const r=verifyNumbers({decision}).decision;
  assert.deepEqual(r.eligible,['at-limit']);
  assert.deepEqual(r.options.map(o=>o.status),['eligible','rejected','unknown','rejected']);
  assert.equal(r.options[1].checks[0].difference,'0.01');
  assert.equal(r.options[2].checks[1].status,'unknown');
  assert.throws(()=>verifyNumbers({decision:{...decision,recommendation:'over'}}),/未通过/);
  assert.throws(()=>verifyNumbers({decision:{...decision,recommendation:'unknown'}}),/未通过/);
});

test('no feasible option remains empty; malformed checks cannot silently pass', () => {
  const d=structuredClone(decision); d.options.shift();
  assert.deepEqual(verifyNumbers({decision:d}).decision.eligible,[]);
  for (const change of [d=>d.constraints=[],d=>d.constraints[0].operator='approximately',d=>d.options.push(d.options[0]),d=>d.options[0].values.offline='yes']) {
    const d=structuredClone(decision);change(d);assert.throws(()=>verifyNumbers({decision:d}));
  }
  assert.throws(()=>verifyNumbers({}));
});

test('exact string boolean repair preserves false, unknown and rejected candidates', () => {
  const d=structuredClone(decision); d.constraints[1].value='true';
  d.options[0].values.offline='true'; d.options[3].values.offline='false';
  const result=verifyNumbers({decision:d}).decision;
  assert.deepEqual(result.eligible,['at-limit']);
  assert.deepEqual(result.options.map(o=>o.status),['eligible','rejected','unknown','rejected']);
  assert.equal(result.options[3].checks[1].actual,false);
});

test('undefined growth does not replace an independent exact change with a made-up result', () => {
  const r=verifyNumbers({calculations:[{label:'change',expression:'42-0'},{label:'growth',expression:'(42-0)/0*100'}]});
  assert.equal(r.calculations[0].result,'42');assert.match(r.calculations[1].error,/除数不能为0/);assert.equal(r.calculations[1].result,undefined);
});

const intent={act:'chat',targetId:'',kind:'general',goal:'核算',agents:['conversation'],operations:['numbers.verify','chat.reply'],forbiddenOperations:[],slots:{},exclude:[],missing:[],clarification:''};
function setup(outputs) {
  const requests=[],calls=[];
  const llm={async chat(args){requests.push(structuredClone(args));assert.ok(outputs.length,'unexpected model call');return outputs.shift();}};
  const prod=createTools({cfg:structuredClone(DEFAULTS),logger:{info(){},warn(){}}});
  const tools={specs:prod.specs,async run(name,args,ctx){calls.push(name);return prod.run(name,args,ctx);}};
  const manager=new AgentManager({llm,tools});
  return {requests,calls,run:()=>manager.run({input:normalizeInput({userText:'更正为6份，每份18.25，算合计。'}),messages:[{role:'system',content:'助手'},{role:'user',content:'此前5份，每份18.25。'},{role:'assistant',content:'91.25元'},{role:'user',content:'现在6份'}],toolCtx:{chatKey:'numeric-test'}})};
}
test('chat route uses actual numeric adapter and exposes previous conversation to intake', async () => {
  const f=setup([{content:JSON.stringify(intent)},{toolCalls:[{id:'c',function:{name:'verify_numbers',arguments:JSON.stringify({calculations:[{label:'合计',expression:'6*18.25'}]})}}]},{content:'合计109.5元。'}]);
  const r=await f.run();assert.equal(r.trace.status,'completed');assert.equal(r.reply,'合计109.5元。');assert.deepEqual(f.calls,['verify_numbers']);
  assert.deepEqual(f.requests[1].tools.map(t=>t.function.name),['verify_numbers']);
  assert.match(f.requests[2].messages.find(m=>m.role==='tool').content,/109.5/);
  assert.equal(JSON.parse(f.requests[0].messages[1].content).conversation.length,2);
});
test('numeric answers without required verification cannot report completion', async () => {
  const f=setup([{content:JSON.stringify(intent)},{content:'不用算，肯定都符合。'}]);
  const r=await f.run();assert.equal(r.trace.status,'partial');assert.notEqual(r.reply,'不用算，肯定都符合。');assert.match(r.reply,/计算与条件核对/);
});
test('ineligible tool recommendation fails workflow instead of accepting model completion claim', async () => {
  const f=setup([{content:JSON.stringify(intent)},{toolCalls:[{id:'c',function:{name:'verify_numbers',arguments:JSON.stringify({decision:{...decision,recommendation:'over'}})}}]},{content:'已确认over符合预算。'}]);
  const r=await f.run();assert.equal(r.trace.status,'partial');assert.doesNotMatch(r.reply,/已确认over/);
});
