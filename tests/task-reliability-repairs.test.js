import test from 'node:test';
import assert from 'node:assert/strict';
import { UnderstandingPipeline, TaskState } from '../src/agents/understanding.js';
import { normalizeInput } from '../src/agents/intent.js';
import { AgentManager } from '../src/agents/manager.js';
import { memoryRecordsForModel, resolveMemoryId } from '../src/memory-handles.js';
import { Brain } from '../src/brain.js';
import { DEFAULTS } from '../src/config.js';
const contract={act:'update',targetId:'',goal:'修改草稿',kind:'general',agents:[],operations:[],forbiddenOperations:[],slots:{},exclude:[],missing:[],clarification:'',execution:'defer'};
for(const [oldFormat,oldFields,newFormat,newFields] of [['ppt',{pages:9},'docx',{sections:4}],['docx',{sections:5},'excel',{rows:3,columns:3,dataPolicy:'provided',dataText:'原始数据'}]])test(`format change ${oldFormat} to ${newFormat} removes only obsolete inherited fields`,async()=>{
  const state=new TaskState(),task=state.add('k',{...contract,operations:['document.create'],agents:['document'],slots:{topic:'原主题',format:oldFormat,...oldFields},forbiddenOperations:['image.generate']});
  const pipeline=new UnderstandingPipeline({state,llm:{async chat(){return {content:JSON.stringify({...contract,targetId:task.id,slots:{topic:'新主题',format:newFormat,...newFields}})};}}});
  const result=await pipeline.prepare('k',normalizeInput({userText:'修改格式，保持草稿'}));
  assert.match(result.reply,/待处理草稿/);assert.equal(task.status,'draft');assert.deepEqual(task.slots,{topic:'新主题',format:newFormat,...newFields});assert.deepEqual(task.forbiddenOperations,['image.generate']);
});
test('model memory handles map exactly to storage IDs without fuzzy matching or changing provenance IDs',()=>{
  const original=[{id:'long-uuid-a',text:'甲'},{id:'long-uuid-b',text:'乙'}],handles=new Map();
  assert.deepEqual(memoryRecordsForModel(original,handles).map(n=>n.id),['m1','m2']);
  assert.equal(resolveMemoryId({memoryHandles:handles},'m2'),'long-uuid-b');
  assert.equal(memoryRecordsForModel([original[1]],handles)[0].id,'m2');assert.equal(original[1].id,'long-uuid-b');
  assert.throws(()=>resolveMemoryId({memoryHandles:handles},'m22'),/不会猜测/);
  assert.throws(()=>resolveMemoryId({memoryHandles:new Map()},'m1'),/不是本轮/);
});
test('a tool name rendered as text is repaired without executing the text as a command',async()=>{
  const responses=[{content:JSON.stringify({...contract,act:'chat',execution:'now',operations:['memory.recall'],agents:['conversation']})},{content:'search_memory\n{"query":"存放点"}'},{toolCalls:[{id:'call',type:'function',function:{name:'search_memory',arguments:'{"query":"存放点"}'}}]},{content:'存放点是东架。'}];
  let calls=0;const manager=new AgentManager({llm:{async chat(){return responses.shift();}},tools:{specs:[{type:'function',function:{name:'search_memory'}}],async run(){calls++;return '存放点是东架。';}}});
  const result=await manager.run({input:normalizeInput({userText:'查询存放点'}),messages:[{role:'system',content:'使用已加载资料回答'}],toolCtx:{chatKey:'k'}});
  assert.equal(calls,1);assert.equal(result.trace.formatRepairs,1);assert.equal(result.reply,'存放点是东架。');assert.equal(result.trace.status,'completed');
});
test('relative expiry intake receives the actual controlled time and model-facing memory IDs',async()=>{
  let intake;const replies=[{content:JSON.stringify({...contract,act:'chat',execution:'now',operations:['memory.recall'],agents:['conversation']})},{content:'已保存。'}];
  const now=Date.parse('2027-02-03T09:30:00Z');
  const brain=new Brain({cfg:DEFAULTS.chat,llm:{async chat(r){if(!intake)intake=JSON.parse(r.messages[1].content);return replies.shift();}},tools:{specs:[]},logger:{info(){},warn(){}},memory:{now:()=>now,context(){return {notes:['原始事实'],noteRecords:[{id:'real-storage-id',text:'原始事实'}],turns:[]};},append(){},async maybeSummarize(){}}});
  await brain.respond({chatKey:'private:7',userText:'今天17:40截止',meta:{actorId:'7'}});
  assert.deepEqual(intake.currentTime,{iso:'2027-02-03T09:30:00.000Z',timezone:'Asia/Shanghai'});assert.equal(intake.memoryRecords[0].id,'m1');
});
