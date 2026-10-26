import test from 'node:test';
import assert from 'node:assert/strict';
import { UnderstandingPipeline, TaskState } from '../src/agents/understanding.js';
import { validateIntent, normalizeInput } from '../src/agents/intent.js';
import { MusicLibrary, resolveCoverTrack } from '../src/library.js';
import { AgentManager } from '../src/agents/manager.js';
const intent = (patch = {}) => ({ act:'create',targetId:'',kind:'general',goal:'任务',agents:['document'],slots:{topic:'任务',format:'ppt'},forbiddenOperations:[],exclude:[],missing:[],clarification:'',...patch,operations:patch.operations ?? (patch.kind==='cover' ? ['cover.perform'] : ['update','reject','cancel','status'].includes(patch.act) ? [] : patch.act==='chat' ? ['chat.reply'] : ['document.create']) });
function setup(outputs, validators={}) {
 const requests=[];
 const p = new UnderstandingPipeline({ validators, llm:{async chat(args) {requests.push(args);return {content:JSON.stringify(outputs.shift())};}} });
 return {p,requests,prepare:(text,key='a')=>p.prepare(key,normalizeInput({userText:text}))};
}
test('missing structured act cannot default into an executable request',()=> {
 assert.throws(()=>validateIntent({goal:'唱歌',agents:['audio'],clarification:''}));
});
test('updates retain confirmed artist and duration and replace only title', async()=>{
 const f=setup([intent({kind:'cover',agents:['audio'],slots:{artist:'罗大佑',title:'光阴的故事',seconds:30},clarification:'确认曲目'}),intent({act:'update',agents:[],slots:{title:'乡愁四韵'}})],{cover:async i=>({value:i.slots})});
 await f.prepare('唱罗大佑的光阴的故事30秒');
 const r=await f.prepare('我让你唱的是乡愁四韵');
 assert.deepEqual(r.intent.slots,{artist:'罗大佑',title:'乡愁四韵',seconds:30});
 assert.equal(f.p.state.list('a').length,1);
});
test('negation does not execute or automatically choose another song',async()=>{
 const f=setup([intent({kind:'cover',agents:['audio'],slots:{title:'乡愁四韵'},clarification:'待确认'}),intent({act:'reject',agents:[],exclude:['光阴的故事']})]);
 await f.prepare('乡愁四韵'); const r=await f.prepare('没让你唱这个光阴的故事啊');
 assert.ok(r.reply); assert.equal(r.intent,undefined); assert.deepEqual(f.p.state.list('a')[0].exclude,['光阴的故事']);
});
test('contradictory new action gets one review, then fails closed if contradiction persists',async()=>{
 const f=setup([intent(),intent()]);
 assert.ok((await f.prepare('不要做PPT')).reply); assert.equal(f.requests.length,2); assert.equal(f.p.state.list('a').length,0);
});
test('multiple tasks and cross-chat references must be clarified',async()=>{
 const f=setup([intent({clarification:'需要主题'}),intent({clarification:'需要图片'}),intent({act:'update'}),intent({act:'update'})]);
 await f.prepare('做PPT');await f.prepare('画图');assert.match((await f.prepare('改一下那个')).reply,/哪项/);
 assert.match((await f.prepare('改一下那个','b')).reply,/没有/);
});
test('status/cancel do not execute; running task cannot be silently replaced',async()=>{
 const f=setup([intent({clarification:'补充主题'}),intent({act:'cancel'}),intent({act:'create'}),intent({act:'update',slots:{topic:'另一个'}})]);
 await f.prepare('做PPT'); assert.match((await f.prepare('别做了')).reply,/取消/);
 await f.prepare('新的任务'); assert.match((await f.prepare('改成别的')).reply,/无法可靠中止/);
});
test('document format update retains topic',async()=>{
 const f=setup([intent({slots:{topic:'年度总结',format:'ppt'},clarification:'需要资料'}),intent({act:'update',slots:{format:'docx'}})]);
 await f.prepare('做年度总结PPT'); const r=await f.prepare('改成Word'); assert.equal(r.intent.slots.topic,'年度总结'); assert.equal(r.intent.slots.format,'docx');
});
test('strict catalog resolution rejects artist-only match and ambiguous versions',()=>{
 const lib=new MusicLibrary({enabled:true,dir:'/not-used'},{});lib.lastScan=Date.now();
 const track=(title)=>({title,artist:'罗大佑',normTitle:title,normArtist:'罗大佑',normFile:'罗大佑'+title});
 lib.tracks=[track('光阴的故事')];
 assert.deepEqual(lib.search('乡愁四韵',{artist:'罗大佑'}),[]);
 assert.ok(resolveCoverTrack(lib,{title:'乡愁四韵',artist:'罗大佑'}).reply);
 lib.tracks.push(track('乡愁四韵'));assert.equal(resolveCoverTrack(lib,{title:'乡愁四韵',artist:'罗大佑'}).value.title,'乡愁四韵');
 lib.tracks.push(track('乡愁四韵'));assert.match(resolveCoverTrack(lib,{title:'乡愁四韵'}).reply,/多个版本/);
});
test('read-only chat cannot invoke mutating conversation tools',async()=>{
 let n=0,runs=0;
 const llm={async chat(){return n++===0 ? {content:JSON.stringify(intent({act:'chat',agents:['conversation']}))} : {toolCalls:[{function:{name:'remember',arguments:'{"text":"x"}'}}]};}};
 const m=new AgentManager({llm,tools:{specs:[{function:{name:'remember'}}],run(){runs++;}}});
 const result=await m.run({input:normalizeInput({userText:'之前做完了吗'}),messages:[{role:'system',content:'助手'}],toolCtx:{chatKey:'a',images:[],voices:[],documents:[],songs:[]}});
 assert.equal(runs,0);assert.equal(result.trace.status,'failed');
});
test('cover dispatch only uses read-only validated track, bypassing free-form tool guesses',async()=>{
 const f=setup([intent({kind:'cover',agents:['audio'],slots:{title:'乡愁四韵',artist:'罗大佑'}})],{cover:()=>({value:{title:'乡愁四韵',path:'/validated'}})});
 let executed;
 const m=new AgentManager({llm:{},understanding:f.p,tools:{},coverExecutor:async(track,slots)=>{executed={track,slots};return {ok:true};}});
 const r=await m.run({input:normalizeInput({userText:'唱罗大佑的乡愁四韵'}),messages:[],toolCtx:{chatKey:'a',images:[],voices:[],documents:[],songs:[]}});
 assert.equal(executed.track.path,'/validated');assert.equal(r.trace.status,'completed');assert.equal(f.p.state.list('a')[0].status,'completed');
});
test('model cannot inject task IDs/status, and mixed cover requests are not silently truncated',async()=>{
 const parsed=validateIntent(intent({id:'forged',status:'completed'}));assert.equal(parsed.id,undefined);assert.equal(parsed.status,undefined);
 const f=setup([intent({kind:'cover',agents:['audio','document'],slots:{title:'乡愁四韵'}})]);
 assert.match((await f.prepare('唱完再做PPT')).reply,/分开/);assert.equal(f.p.state.list('a').length,0);
});
