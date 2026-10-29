import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../src/agents/manager.js';
import { UnderstandingPipeline, TaskState } from '../src/agents/understanding.js';
import { normalizeInput } from '../src/agents/intent.js';
const intent=operations=>({act:'chat',targetId:'',kind:'general',goal:'回忆',agents:['conversation'],operations,forbiddenOperations:[],slots:{},exclude:[],missing:[],clarification:''});
async function run(operations){
 const requests=[],outputs=[{content:JSON.stringify(intent(operations))},{content:'保存的偏好是无香型。'}];
 const llm={async chat(r){requests.push(r);return outputs.shift();}};
 const manager=new AgentManager({llm,tools:{specs:[{type:'function',function:{name:'search_history'}}],run(){assert.fail('unexpected tool');}}});
 const result=await manager.run({input:normalizeInput({userText:'我的保存偏好是什么？',memoryRecords:[{id:'n',text:'偏好无香型',scope:'permanent'}]}),messages:[{role:'system',content:'已加载有效记忆'}],toolCtx:{chatKey:'private:test'}});
 return {result,requests};
}
test('already loaded active notes can be recalled without a redundant historical lookup',async()=>{
 const {result,requests}=await run(['memory.recall']);assert.equal(result.trace.status,'completed');assert.equal(result.reply,'保存的偏好是无香型。');assert.equal(JSON.parse(requests[0].messages[1].content).memoryRecords[0].text,'偏好无香型');
});
test('explicit history lookup still requires a tool receipt even when notes exist',async()=>{
 const {result}=await run(['memory.read']);assert.equal(result.trace.status,'partial');assert.match(result.reply,/历史记录查询没有完成/);
});
test('finished memory mutation payloads are absent from the next task-understanding snapshot',async()=>{
 const state=new TaskState();const old=state.add('x',{...intent(['memory.write']),goal:'已删除的旧资料',slots:{text:'已删除的旧资料'}});state.finish(old,'completed');
 let request;const pipeline=new UnderstandingPipeline({state,llm:{async chat(r){request=r;return {content:JSON.stringify(intent(['memory.recall']))};}}});
 await pipeline.prepare('x',normalizeInput({userText:'当前记忆是什么？'}));assert.deepEqual(JSON.parse(request.messages[1].content).tasks,[]);assert.doesNotMatch(request.messages[1].content,/已删除的旧资料/);
});
