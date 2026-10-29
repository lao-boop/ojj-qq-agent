import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../src/agents/manager.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';
import { normalizeInput } from '../src/agents/intent.js';

const I = (ops, slots = {}, patch = {}) => ({ act:'create',targetId:'',kind:'general',goal:'用户任务',agents:['conversation'],operations:ops,forbiddenOperations:[],slots,exclude:[],missing:[],clarification:'',...patch });
const json = v => ({ content:JSON.stringify(v) });
const call = (name,args={}) => ({ id:name,function:{name,arguments:JSON.stringify(args)} });
const response = (...toolCalls) => ({ content:'',toolCalls });
function setup(outputs, { result='成功', config={} } = {}) {
  const requests=[],runs=[],ctx={chatKey:'test',images:[],voices:[],documents:[],songs:[]};
  const llm={async chat(args){requests.push(structuredClone(args));assert.ok(outputs.length,'unexpected model call');return outputs.shift();}};
  const tools={specs:['search_web','search_history','get_time','make_docx','draw_image','send_voice','remember','post_qzone'].map(name=>({type:'function',function:{name}})),async run(name,args,c){
    runs.push({name,args});if(name==='make_docx')c.documents.push({kind:'docx'});if(name==='draw_image')c.images.push({file:'mock.png'});return result;
  }};
  const m=new AgentManager({llm,tools,config});
  return {requests,runs,ctx,run:()=>m.run({input:normalizeInput({userText:'请查询配件并写报告'}),messages:[{role:'system',content:'助手'}],toolCtx:ctx})};
}

test('one agent selects tools through research -> document workflow without planner or specialist calls',async()=>{
  const f=setup([json(I(['research.search','document.create'],{query:'刹车片',topic:'配件报告',format:'docx'})),response(call('search_web')),response(call('make_docx')),{content:'已经送达文件'}],{result:'检索依据：钢背与摩擦材料'});
  const r=await f.run();assert.equal(r.trace.status,'completed');assert.equal(r.trace.architecture,'single-agent-workflows');
  assert.equal(f.requests.length,4);assert.ok(f.requests.slice(1).every(r=>r.messages[0].content.includes('单主 Agent')));
  assert.deepEqual(f.requests[1].tools.map(s=>s.function.name),['search_web']);
  assert.ok(f.requests[2].tools.some(s=>s.function.name==='make_docx'));
  assert.ok(f.requests[2].messages.some(m=>m.role==='tool'&&m.content.includes('摩擦材料')));
  assert.ok(f.ctx.documents[0].context.includes('摩擦材料'));
  assert.deepEqual(r.trace.steps[1].dependsOn,[r.trace.steps[0].id]);assert.equal(r.trace.steps[1].kind,'workflow');
  assert.match(r.reply,/排队.*尚未确认/);assert.doesNotMatch(r.reply,/已经送达/);
});

test('workflow rejects a document call before its requested research has run',async()=>{
  const f=setup([json(I(['research.search','document.create'],{query:'太阳能',topic:'能源',format:'docx'})),response(call('make_docx'))]);
  const r=await f.run();assert.equal(r.trace.status,'failed');assert.equal(f.runs.length,0);assert.match(r.trace.error,/denied/);
});

test('failed research never unlocks downstream production even when the model claims success',async()=>{
  const f=setup([json(I(['research.search','document.create'],{query:'太阳能',topic:'能源',format:'docx'})),response(call('search_web')),{content:'我已做完报告'}],{result:'工具执行失败：网络不可用'});
  const r=await f.run();assert.equal(r.trace.status,'partial');assert.equal(r.trace.steps[1].status,'blocked');assert.equal(f.ctx.documents.length,0);
  assert.equal(f.requests[2].tools.length,0);assert.match(r.reply,/没有完成/);
});

test('malformed second tool prevents all effects before a single bounded format repair',async()=>{
  const broken={id:'bad',function:{name:'send_voice',arguments:'{"text":'}};
  const f=setup([json(I(['speech.synthesize'],{text:'你好。'})),response(call('send_voice'),broken),response(call('send_voice')),{content:'完成'}]);
  const r=await f.run();assert.equal(r.trace.status,'completed');assert.equal(r.trace.formatRepairs,1);assert.equal(f.runs.length,1);assert.equal(f.runs[0].args.text,'你好。');
  assert.ok(f.requests[2].messages.some(m=>m.role==='system'&&m.content.includes('均未执行')));
});

test('truncated responses execute no tools and format repair never loops indefinitely',async()=>{
  const truncated={...response(call('draw_image')),finishReason:'length'};
  const f=setup([json(I(['image.generate'],{prompt:'cat'})),truncated,truncated]);
  const r=await f.run();assert.equal(r.trace.status,'failed');assert.equal(f.runs.length,0);assert.equal(f.requests.length,3);assert.equal(r.trace.formatRepairs,1);
});

test('duplicate requests reuse artifacts within the tool budget',async()=>{
  const f=setup([json(I(['image.generate'],{prompt:'cat'})),response(call('draw_image')),response(call('draw_image')),{content:'完成'}],{config:{maxToolCalls:1}});
  const r=await f.run();assert.equal(r.trace.status,'completed');assert.equal(f.runs.length,1);assert.equal(f.ctx.images.length,1);
});

test('new tool names and writes during read-only chat remain denied',async()=>{
  for(const name of ['post_qzone','remember']){
    const f=setup([json(I(['chat.reply'],{},{act:'chat'})),response(call(name,{text:'x'}))]);
    assert.equal((await f.run()).trace.status,'failed');assert.equal(f.runs.length,0);
  }
});

test('deferred drafts preserve constraints, require explicit resume, and can be cancelled then queried',async()=>{
  const outputs=[I(['document.create'],{format:'ppt',pages:8},{execution:'defer',forbiddenOperations:['image.generate']}),I([],{topic:'年度报告'},{act:'update'}),I([],{},{act:'update',execution:'now'})];
  const p=new UnderstandingPipeline({llm:{chat:async()=>json(outputs.shift())}});
  const first=await p.prepare('x',normalizeInput({userText:'先记下8页PPT，稍后开始'}));assert.equal(first.task.status,'draft');
  const second=await p.prepare('x',normalizeInput({userText:'主题年度报告'}));assert.equal(second.task.status,'draft');assert.equal(second.intent,undefined);
  const third=await p.prepare('x',normalizeInput({userText:'现在开始'}));assert.equal(third.intent.slots.pages,8);assert.deepEqual(third.intent.forbiddenOperations,['image.generate']);
  p.state.finish(third.task,'draft');outputs.push(I([],{},{act:'cancel'}),I([],{},{act:'status'}));
  await p.prepare('x',normalizeInput({userText:'取消'}));const status=await p.prepare('x',normalizeInput({userText:'刚才取消的状态'}));assert.match(status.reply,/已取消/);
});

test('captured document prohibition does not trigger an unrelated negation review',async()=>{
  let calls=0;const p=new UnderstandingPipeline({llm:{chat:async()=>{calls++;return json(I(['image.generate'],{prompt:'cat',size:'square'},{forbiddenOperations:['document.create']}));}}});
  const r=await p.prepare('x',normalizeInput({userText:'不是不让你画猫。现在画猫，别做文档。'}));assert.ok(r.intent,r.reply);assert.equal(calls,1);
});

test('read-only file requests with a prohibition avoid redundant recognition but cannot write',async()=>{
  const outputs=[json(I(['chat.reply'],{inputRef:'file',fileName:'B.txt'},{forbiddenOperations:['document.create']})),response(call('make_docx'))];
  const f=setup(outputs);
  // Exercise the lexical review separately with the actual file instruction.
  let calls=0;
  const p=new UnderstandingPipeline({llm:{chat:async()=>{calls++;return outputs[0];}}});
  const r=await p.prepare('file',normalizeInput({userText:'只总结B.txt，不要生成新文件。',attachments:{files:[{name:'A.txt'},{name:'B.txt'}]}}));
  assert.ok(r.intent,r.reply);assert.equal(calls,1);
  // With valid inputs supplied at intake, a fabricated model write is still denied.
  f.requests.length=0;
  outputs[0]=json(I(['chat.reply'],{},{forbiddenOperations:['document.create']}));
  assert.equal((await f.run()).trace.status,'failed');assert.equal(f.runs.length,0);
});

test('document creation waits for requested memory and time receipts',async()=>{
  const f=setup([json(I(['memory.read','time.read','document.create'],{topic:'活动回顾',format:'docx'})),response(call('search_history'),call('get_time')),response(call('make_docx')),{content:'完成'}]);
  const r=await f.run();assert.equal(r.trace.status,'completed');
  assert.deepEqual(f.requests[1].tools.map(s=>s.function.name),['search_history','get_time']);
  assert.ok(f.requests[2].tools.some(s=>s.function.name==='make_docx'));
  assert.deepEqual(r.trace.steps.find(s=>s.agent==='document').dependsOn,['phase-conversation']);
  assert.ok(f.ctx.documents[0].context.includes('search_history'));
});

test('deferred missing historical input explains the blocker and preserves the draft',async()=>{
  const p=new UnderstandingPipeline({llm:{chat:async()=>json(I(['document.create'],{topic:'历史销售',format:'docx',inputRef:'history'},{execution:'defer'}))}});
  const r=await p.prepare('history',normalizeInput({userText:'用上次的文件做报告'}));
  assert.match(r.reply,/历史附件还没有定位/);assert.equal(r.task.status,'draft');assert.equal(r.intent,undefined);
});

test('failed lookup gives a verification next step without claiming a result or delivery',async()=>{
  const f=setup([json(I(['research.search'],{query:'某场馆今天是否开放'})),response(call('search_web')),{content:'今天正常开放，已经查证'}],{result:'工具执行失败：连接超时'});
  const r=await f.run();assert.equal(r.trace.status,'partial');
  assert.match(r.reply,/查询.*没有完成/);assert.match(r.reply,/官方.*公告|官方联系电话/);
  assert.doesNotMatch(r.reply,/今天正常开放|已经查证|生成或发送了产物/);
});

for(const act of ['create','chat'])test(`missing attachment ${act} produces a usable explanation instead of an internal key`,async()=>{
  const p=new UnderstandingPipeline({llm:{chat:async()=>json(I(['chat.reply'],{},{act,missing:['inputRef']}))}});
  const r=await p.prepare('file',normalizeInput({userText:'请核对附件'}));
  assert.match(r.reply,/没有收到.*附件/);assert.match(r.reply,/上传|粘贴/);assert.doesNotMatch(r.reply,/inputRef/);assert.equal(r.intent,undefined);
});

test('unknown missing keys stay private and an explicit clarification is preserved',async()=>{
  const p=new UnderstandingPipeline({llm:{chat:async()=>json(I(['chat.reply'],{},{missing:['internal_unused_field']}))}});
  const r=await p.prepare('file',normalizeInput({userText:'请核对'}));assert.doesNotMatch(r.reply,/internal_unused_field/);assert.match(r.reply,/信息|材料/);
  p.llm.chat=async()=>json(I(['chat.reply'],{},{missing:['inputRef'],clarification:'请提供报价单与采购清单。'}));
  assert.equal((await p.prepare('another',normalizeInput({userText:'请核对'}))).reply,'请提供报价单与采购清单。');
});
