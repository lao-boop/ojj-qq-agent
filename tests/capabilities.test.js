import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIntent, normalizeInput } from '../src/agents/intent.js';
import { UnderstandingPipeline } from '../src/agents/understanding.js';
import { allowedTools, bindArguments, validateCapabilities } from '../src/agents/capabilities.js';
import { AgentManager } from '../src/agents/manager.js';
const I = (operations, slots={}, patch={}) => ({ act:'create',targetId:'',kind:'general',goal:'用户任务',agents:['conversation'],operations,forbiddenOperations:[],slots,exclude:[],missing:[],clarification:'',...patch });
const input = (patch={}) => ({...normalizeInput({userText:'请处理这项任务'}),...patch});
for (const [name,intent,expected] of [
 ['文档缺主题',I(['document.create'],{format:'ppt'}),'主题'],
 ['文档缺格式',I(['document.create'],{topic:'总结'}),'Word'],
 ['Excel未决定数据来源',I(['document.create'],{format:'excel',topic:'销售'}),'真实数据'],
 ['真实数据缺失不能填造',I(['document.create'],{format:'excel',topic:'销售',dataPolicy:'provided'}),'真实数据'],
 ['绘图缺画面',I(['image.generate']),'画什么'],
 ['朗读缺原文',I(['speech.synthesize']),'朗读'],
 ['语音不能悄悄截断',I(['speech.synthesize'],{text:'字'.repeat(121)}),'截断'],
 ['原创歌缺主题',I(['music.compose']),'主题'],
 ['检索缺查询对象',I(['research.search']),'查询'],
 ['汽修无可见证据',I(['automotive.identify']),'图片'],
 ['私有记忆不能擅自公开',I(['memory.publish'],{text:'喜欢蓝色'}),'公开'],
 ['要求和禁止冲突',I(['image.generate'],{prompt:'猫'},{forbiddenOperations:['image.generate']}),'禁止'],
 ['混合外部动作不能只做一半',I(['document.create','relay.send'],{format:'docx',topic:'报告'}),'拆开'],
 ['历史附件未定位',I(['chat.reply'],{inputRef:'history'}),'定位'],
]) test(name,()=> assert.ok(validateCapabilities(intent,input()).includes(expected)));

test('看图只授权阅读，不能画图；语音只授权朗读，不能作曲',()=>{
 assert.deepEqual([...allowedTools(I(['image.inspect']))],[]);
 assert.deepEqual([...allowedTools(I(['speech.synthesize'],{text:'你好'}))],['send_voice']);
});
test('附件失败、缺失与多文件歧义都阻止执行',()=>{
 const q=I(['chat.reply'],{inputRef:'file'});
 assert.match(validateCapabilities(q,input()),/没有收到/);
 assert.match(validateCapabilities(q,input({attachments:{files:[{name:'a'},{name:'b'}]}})),/多个/);
 assert.match(validateCapabilities({...q,slots:{inputRef:'file',fileName:'missing'}},input({attachments:{files:[{name:'a'}]}})),/文件名/);
 assert.match(validateCapabilities(q,input({attachments:{files:[{name:'a'}]},evidence:'读取失败'})),/读取/);
 assert.match(validateCapabilities(I(['image.inspect']),input({imageCount:1,imageReadFailed:true})),/读取/);
});
test('页数、行数等超出执行能力不得静默夹取；未知操作拒绝',()=>{
 for(const slots of [{pages:100},{rows:2},{columns:30},{size:'guess'}]) assert.throws(()=>validateIntent(I(['document.create'],slots)));
 assert.throws(()=>validateIntent(I(['delete.everything'])));
});
test('确认参数绑定到执行参数，模型不能改成另一主题或念另一句话',()=>{
 const a=bindArguments('make_ppt',{topic:'随便主题',pages:20},I(['document.create'],{topic:'年度总结',format:'ppt',pages:8}));
 assert.equal(a.pages,8);assert.ok(a.topic.startsWith('年度总结'));
 assert.equal(bindArguments('send_voice',{text:'错误'},I(['speech.synthesize'],{text:'晚安'})).text,'晚安');
 assert.ok(!allowedTools(I(['document.create'],{format:'docx'})).has('make_ppt'));
});
test('资料查询不能越权创建文件，即使专业Agent请求该工具',async()=>{
 const values=[{content:JSON.stringify(I(['research.search'],{query:'天气'}))},{toolCalls:[{function:{name:'make_docx',arguments:'{"topic":"天气"}'}}]}];
 let runs=0;
 const manager=new AgentManager({llm:{chat:async()=>values.shift()},tools:{specs:[{function:{name:'search_web'}},{function:{name:'make_docx'}}],run:()=>runs++}});
 const r=await manager.run({input:input(),messages:[{role:'system',content:'助手'}],toolCtx:{chatKey:'a',images:[],voices:[],documents:[],songs:[]}});
 assert.equal(runs,0);assert.equal(r.trace.status,'failed');
});
test('修改文档保留主题和禁止配图条件',async()=>{
 const values=[I(['document.create'],{format:'ppt',topic:'预算',pages:8},{forbiddenOperations:['image.generate'],clarification:'缺资料'}),I([],{audience:'财务部'},{act:'update'})];
 const p=new UnderstandingPipeline({llm:{chat:async()=>({content:JSON.stringify(values.shift())})}});
 await p.prepare('a',input());const r=await p.prepare('a',input());
 assert.equal(r.intent.slots.pages,8);assert.equal(r.intent.slots.topic,'预算');assert.deepEqual(r.intent.forbiddenOperations,['image.generate']);
});
test('仅口头说生成完毕不能成为任务完成',async()=>{
 const values=[{content:JSON.stringify(I(['image.generate'],{prompt:'猫'}))},{content:'画好了'},{content:'画好了'}];
 const m=new AgentManager({llm:{chat:async()=>values.shift()},tools:{specs:[],run(){throw Error('unexpected');}}});
 const r=await m.run({input:input(),messages:[{role:'system',content:'助手'}],toolCtx:{chatKey:'a',images:[],voices:[],documents:[],songs:[]}});
 assert.equal(r.trace.status,'partial');assert.deepEqual(r.trace.unfulfilled,['image.generate']);assert.match(r.reply,/没有完成/);
});
test('普通聊天的看图请求也经过输入核验',async()=>{
 const p=new UnderstandingPipeline({llm:{chat:async()=>({content:JSON.stringify(I(['image.inspect'],{},{act:'chat'}))})}});
 assert.match((await p.prepare('a',input())).reply,/没有收到/);
});
test('明确不画图但做文档，不因为含有否定词反复追问',async()=>{
 let calls=0;
 const p=new UnderstandingPipeline({llm:{chat:async()=>{calls++;return {content:JSON.stringify(I(['document.create'],{format:'ppt',topic:'工作总结'},{forbiddenOperations:['image.generate']}))};}}});
 const r=await p.prepare('a',input({instruction:'不要画图，只做工作总结PPT'}));
 assert.ok(r.intent);assert.equal(calls,1);assert.ok(!allowedTools(r.intent).has('draw_image'));
});
test('禁止配图和真实数据要求传入后台文档队列',async()=>{
 const task=I(['document.create'],{format:'excel',topic:'真实销售表',dataPolicy:'provided',dataText:'一月销售额100元'},{agents:['document'],forbiddenOperations:['image.generate']});
 const replies=[{content:JSON.stringify(task)},{toolCalls:[{id:'x',function:{name:'make_excel',arguments:'{"topic":"错误主题"}'}}]},{content:'已排队'},{content:'表格正在生成'}];
 const ctx={chatKey:'a',images:[],voices:[],documents:[],songs:[]};
 const m=new AgentManager({llm:{chat:async()=>replies.shift()},tools:{specs:[{function:{name:'make_excel'}}],async run(name,args,ctx){ctx.documents.push({kind:'excel',topic:args.topic});return '已排队';}}});
 await m.run({input:input(),messages:[{role:'system',content:'助手'}],toolCtx:ctx});
 assert.equal(ctx.documents[0].dataPolicy,'provided');assert.equal(ctx.documents[0].withImages,false);assert.match(ctx.documents[0].context,/100元/);
});
