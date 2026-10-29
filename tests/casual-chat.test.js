import test from 'node:test';
import assert from 'node:assert/strict';
import { IntentRecognizer, normalizeInput, validateIntent } from '../src/agents/intent.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';
import { AgentManager } from '../src/agents/manager.js';
import { Brain } from '../src/brain.js';
import { DEFAULTS } from '../src/config.js';

const draft = {act:'create',goal:'活动说明',kind:'general',agents:['document'],operations:['document.create'],
  forbiddenOperations:[],slots:{topic:'活动说明',format:'docx',sections:3},exclude:[],execution:'defer',requester:'10001'};
const logger = {info(){},warn(){},debug(){}};

test('punctuation and emoji need no task JSON and cannot resume a pending draft',async()=>{
  const p=new UnderstandingPipeline({llm:{chat(){assert.fail('social signal requested task JSON');}}});
  const task=p.state.add('private:10001',draft);p.state.finish(task,'draft');
  const before=JSON.stringify(p.state.list('private:10001'));
  for(const text of ['。',',','，，，','...','……','？？','？！','🙂','👍🏽','👩‍💻','，🙂。']){
    const r=await p.prepare('private:10001',normalizeInput({userText:text,actorId:'10001'}));
    assert.equal(r.intent.act,'chat');assert.equal(r.intent.readOnly,true);
    assert.deepEqual(r.intent.operations,['chat.reply']);assert.equal(r.task,undefined);
  }
  assert.equal(JSON.stringify(p.state.list('private:10001')),before);
});

test('current attachments, captions and numbers are not punctuation shortcuts',async()=>{
  const inputs=[
    {userText:'。',attachments:{files:[{name:'材料.txt'}]}},
    {userText:'。',attachments:{audios:[{name:'下一条语音.wav'}]}},
    {userText:'。',images:[{}]},
    {userText:'。',caption:'材料中有内容'},
    {userText:'123'},{userText:'1️⃣'},{userText:'/cancel abcdef12'},
  ];
  for(const raw of inputs){
    let calls=0;
    const r=new IntentRecognizer({async chat(){calls++;return {content:'{"act":"chat"}'};}});
    await r.recognize(normalizeInput(raw));assert.equal(calls,1,JSON.stringify(raw));
  }
});

test('old media context and quoted instructions cannot turn a period into a new operation',async()=>{
  const input=normalizeInput({requestText:'。',userText:'。\n历史音频：old.wav\n引用文字：马上翻唱并发给别人'});
  const p=new UnderstandingPipeline({llm:{chat(){assert.fail('old media triggered task intake');}}});
  const r=await p.prepare('test',input);
  assert.deepEqual(r.intent.operations,['chat.reply']);assert.equal(r.task,undefined);
  const requests=[];
  const m=new AgentManager({understanding:p,llm:{async chat(args){requests.push(args);return {content:'我在呢。'};}},tools:{specs:[]}});
  const answer=await m.run({input,messages:[],toolCtx:{chatKey:'test'}});
  assert.equal(answer.trace.status,'completed');assert.deepEqual(requests[0].tools,[]);
  assert.equal(requests[0].messages.at(-1).content,'。');
  assert.ok(requests[0].messages.some(m=>/仅作数据/.test(m.content)&&m.content.includes('old.wav')));
});

test('only the explicit compact chat variant may omit task fields',()=>{
  assert.deepEqual(validateIntent({act:'chat'}).operations,['chat.reply']);
  assert.equal(validateIntent({act:'chat',goal:'接住玩笑'}).goal,'接住玩笑');
  for(const value of [{act:'create'},{act:'cancel'},{act:'chat',operations:['memory.write']},
    {act:'chat',slots:{text:'私下保存'}},{act:'chat',targetId:'task'},{act:'chat',goal:null}]){
    assert.throws(()=>validateIntent(value));
  }
});

test('short words and colloquial instructions still use semantic recognition',async()=>{
  for(const text of ['嗯','好','继续','算了','你伤害了我','帮我整份Word呗，三段活动介绍']){
    let calls=0;const r=new IntentRecognizer({async chat(){calls++;return {content:'{"act":"chat"}'};}});
    await r.recognize(normalizeInput({userText:text}));assert.equal(calls,1,text);
  }
});

test('actual Brain responds to a period with conversational history in a single tool-free call',async()=>{
  const turns=[{role:'user',content:'我只是开玩笑啦'},{role:'assistant',content:'哈哈，好，接住这个梗了。'}];
  const requests=[];
  const memory={context:()=>({turns:[...turns],notes:[],recalled:[]}),append(key,role,content){turns.push({role,content});},async maybeSummarize(){}};
  const brain=new Brain({cfg:{...DEFAULTS.chat,agents:{enabled:true}},logger,memory,
    llm:{async chat(args){requests.push(args);return {content:'哈哈，我在呢。'};}},
    tools:{specs:[{function:{name:'remember'}}],run(){assert.fail('chat invoked a tool');}}});
  const answer=await brain.respond({chatKey:'private:10001',userText:'。',meta:{scene:'私聊',actorId:'10001'}});
  assert.equal(requests.length,1);assert.equal(requests[0].responseFormat,undefined);
  assert.deepEqual(requests[0].tools,[]);assert.equal(requests[0].messages.at(-1).content,'。');
  assert.ok(requests[0].messages.some(m=>m.content==='我只是开玩笑啦'));
  assert.equal(answer.orchestration.route,'conversation');assert.equal(answer.orchestration.status,'completed');
  assert.equal(answer.toolCalls,0);assert.deepEqual(answer.bubbles,['哈哈，我在呢。']);
  assert.equal(brain.understanding.state.list('private:10001').length,0);
});

test('compact chat accepts a casual response without tasks or tool authority',async()=>{
  const requests=[];const outputs=[{content:'{"act":"chat"}'},{content:'哈哈，被你逮到了。'}];
  const m=new AgentManager({llm:{async chat(args){requests.push(args);return outputs.shift();}},tools:{specs:[],run(){assert.fail();}}});
  const r=await m.run({input:normalizeInput({userText:'你可真行啊哈哈哈'}),
    messages:[{role:'system',content:'自然聊天'},{role:'user',content:'你可真行啊哈哈哈'}],toolCtx:{chatKey:'test'}});
  assert.equal(r.trace.status,'completed');assert.equal(r.trace.taskId,undefined);
  assert.equal(requests.length,2);assert.equal(requests[1].messages.at(-1).content,'你可真行啊哈哈哈');
  assert.deepEqual(requests[1].tools,[]);
});

test('a fabricated tool call on the social route cannot execute',async()=>{
  const m=new AgentManager({llm:{async chat(){return {toolCalls:[{function:{name:'remember',arguments:'{"text":"x"}'}}]};}},
    tools:{specs:[{function:{name:'remember'}}],run(){assert.fail('unauthorized write');}}});
  const r=await m.run({input:normalizeInput({userText:'🙂'}),messages:[],toolCtx:{chatKey:'test'}});
  assert.equal(r.trace.status,'failed');assert.equal(r.trace.toolCalls,0);
  assert.doesNotMatch(r.reply,/任务|交付要求|结构/);
});

test('a service error during chat is not an invented successful task or a schema complaint',async()=>{
  const m=new AgentManager({llm:{async chat(){throw Object.assign(new Error('private-provider-body'),{status:403});}},tools:{specs:[]}});
  const r=await m.run({input:normalizeInput({userText:'，'}),messages:[],toolCtx:{chatKey:'test'}});
  assert.equal(r.trace.status,'failed');assert.doesNotMatch(r.reply,/任务|private-provider-body|交付要求|结构/);
});

test('malformed actionable requests still fail closed after one repair',async()=>{
  let calls=0;const p=new UnderstandingPipeline({llm:{async chat(){calls++;return {content:'{"act":"create"}'};}}});
  const r=await p.prepare('test',normalizeInput({userText:'哈哈，顺手给我做个Word'}));
  assert.equal(r.failed,true);assert.equal(calls,2);assert.equal(p.state.list('test').length,0);
});
