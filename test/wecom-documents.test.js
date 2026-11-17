import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DocumentInbox} from '../src/doc-inbox.js';
import {WeComDocuments} from '../src/wecom-documents.js';
import {normalizeConfig, DEFAULTS} from '../src/config.js';
import {createTools} from '../src/tools.js';

function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-docs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cfg=structuredClone(DEFAULTS);cfg.wecom.botId='bot-a';cfg.wecom.secretary={enabled:true,ownerUserId:'owner',intervalMinutes:60};
 const key=id=>`wecom:${cfg.wecom.botId}:private:${id}`;
 const secretary={isOwner:k=>cfg.wecom.secretary.enabled && k===key(cfg.wecom.secretary.ownerUserId),records:[],eligible:()=>true};
 const manual=new Map([['alice',{name:'小林'}],['bob',{name:'小陈'}]]);
 const contacts={manual,cache:new Map(),peek:id=>({name:manual.get(id)?.name || '',stale:false})};
 const sent=[];let spec;
 const sender={async sendFile(frame,file,name,opts){assert.ok(opts.validate());sent.push({frame,file,name});}};
 const llm={async chat(){return {content:'小林提交了采购方案，预算500元，日期待定。',finishReason:'stop'};}};
 const officeFactory=()=>({async makeSummaryDocx(args){spec=args;return {file:path.join(dir,'summary.docx'),name:'summary.docx'};}});
 const docs=new WeComDocuments({cfg,dataDir:dir,secretary,contacts,sender,llm,officeFactory});
 const chat=id=>({key:key(id),userId:id,id,group:false,identity:{name:contacts.peek(id).name}});
 const add=(id='alice',name='采购.docx',text='预算500元，日期待定')=>{
   const file=path.join(dir,id+'-'+name);fs.writeFileSync(file,'fixture');docs.capture(chat(id),[{path:file,name,text,chars:text.length}],id+name);return file;
 };
 const ctx=()=>({chatKey:key('owner'),files:[],documents:[]});
 return {dir,cfg,docs,contacts,secretary,sent,llm,add,ctx,chat,key,built:()=>spec};
}

test('document inbox persists, deduplicates, preserves pending documents and rejects corrupt stores',t=>{
 const x=setup(t),file=path.join(x.dir,'inbox.json'),box=new DocumentInbox(file);
 assert.equal(box.add({uin:'a',name:'x.docx',filePath:'/a',text:'x'.repeat(7000)}),true);
 assert.equal(box.add({uin:'a',name:'x.docx',filePath:'/a'}),false);
 const loaded=new DocumentInbox(file);assert.equal(loaded.stats().pending,1);assert.equal(loaded.list()[0].truncated,true);
 loaded.mark([loaded.list()[0].id]);assert.equal(loaded.stats().pending,0);
 fs.writeFileSync(file,'broken');assert.throws(()=>loaded.add({uin:'b',name:'y',filePath:'/b'}));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('full inbox never silently discards pending documents',t=>{
 const x=setup(t);x.docs.inbox.save(Array.from({length:400},(_,i)=>({id:String(i),uin:'a',path:'/p'+i,name:String(i),summarized:false})));
 assert.throws(()=>x.add(),/已满/);assert.equal(x.docs.inbox.load().length,400);
});
test('inboxes separate bots and accept only allowed private files while enabled',t=>{
 const x=setup(t);x.add();assert.equal(x.docs.list({hours:48}).length,1);
 x.docs.capture({...x.chat('bob'),group:true},[{path:'/unused',name:'group.docx'}]);assert.equal(x.docs.inbox.load().length,1);
 x.cfg.wecom.mode='whitelist';x.cfg.wecom.userAllow=['owner'];x.add('bob');assert.equal(x.docs.list({hours:48}).length,0);
 x.cfg.wecom.mode='open';x.cfg.wecom.botId='bot-b';x.docs.updateConfig(x.cfg);assert.equal(x.docs.inbox.load().length,0);
 x.cfg.wecom.secretary.enabled=false;x.add();assert.equal(x.docs.inbox.load().length,0);
});
test('owner-only tool schemas and execution reject colleagues, groups and QQ',async t=>{
 const x=setup(t);x.add();const tools=x.docs.wrapTools({specs:[],run:async()=>''});
 for(const chatKey of [x.key('alice'),'wecom:bot-a:group:owner','private:owner','wecom:other:private:owner']) {
   assert.equal(tools.specsForChat({chatKey}).length,0);
   assert.match(await tools.run('inbox_list',{}, {chatKey}),/只有/);
 }
 assert.equal(tools.specsForChat(x.ctx()).length,4);
 const list=JSON.parse(await tools.run('inbox_list',{},x.ctx()));assert.equal(list.documents[0].sender,'小林');assert.equal(list.total,1);
});
test('summary remains pending until delivery and contains submitter/time provenance',async t=>{
 const x=setup(t);x.add();const ctx=x.ctx();await x.docs.run('summarize_inbox',{},ctx);
 assert.equal(ctx.documents[0].kind,'inbox');assert.equal(x.docs.inbox.stats().pending,1);
 const result=await x.docs.buildSummary(ctx.documents[0],ctx.chatKey,new AbortController().signal);
 assert.equal(x.docs.inbox.stats().pending,1);assert.match(JSON.stringify(x.built()),/小林|500/);assert.match(JSON.stringify(x.built()),/收到于/);
 x.docs.delivered(result);assert.equal(x.docs.inbox.stats().pending,0);
});
test('summary model failure or truncation leaves every source pending',async t=>{
 for(const response of [{content:'',finishReason:'stop'},{content:'partial',finishReason:'length'}]) {
  const x=setup(t);x.add();x.llm.chat=async()=>response;const ctx=x.ctx();await x.docs.run('summarize_inbox',{},ctx);
  await assert.rejects(x.docs.buildSummary(ctx.documents[0],ctx.chatKey,new AbortController().signal));assert.equal(x.docs.inbox.stats().pending,1);
 }
});
test('owner changes and cancellation during summary generation prevent building or delivery marking',async t=>{
 const x=setup(t);x.add();const ctx=x.ctx();await x.docs.run('summarize_inbox',{},ctx);
 x.llm.chat=async()=>{x.cfg.wecom.secretary.ownerUserId='bob';x.docs.updateConfig(x.cfg);return {content:'summary'};};
 await assert.rejects(x.docs.buildSummary(ctx.documents[0],ctx.chatKey),/权限/);assert.equal(x.docs.inbox.stats().pending,1);assert.equal(x.built(),undefined);
 const y=setup(t);y.add();const c=y.ctx();await y.docs.run('summarize_inbox',{},c);const controller=new AbortController();controller.abort();
 await assert.rejects(y.docs.buildSummary(c.documents[0],c.chatKey,controller.signal),{name:'AbortError'});
});
test('file forwarding uses precise corporate recipient and original bytes, rejects namesakes and blocked members',async t=>{
 const x=setup(t);const source=x.add('owner','方案.docx');const ctx=x.ctx();
 assert.match(await x.docs.run('forward_file',{to:'小陈',file:'方案'},ctx),/已把/);assert.equal(x.sent[0].frame.body.from.userid,'bob');assert.equal(x.sent[0].file,source);
 x.contacts.manual.set('bob2',{name:'小陈'});await assert.rejects(x.docs.run('forward_file',{to:'小陈',file:'方案'},ctx),/同名/);
 await assert.rejects(x.docs.run('forward_file',{to:'他',file:'方案'},ctx),/明确接收人/);
 x.cfg.wecom.mode='whitelist';x.cfg.wecom.userAllow=['owner'];await assert.rejects(x.docs.run('forward_file',{to:'bob',file:'方案'},ctx),/允许范围/);
 assert.equal(x.sent.length,1);
});
test('file lookup cannot scan arbitrary paths or mix same-name documents from different submitters',async t=>{
 const x=setup(t);x.add();x.add('bob');await assert.rejects(x.docs.run('send_document',{keyword:'采购'},x.ctx()),/多份/);
 const selected=x.ctx();await x.docs.run('send_document',{keyword:'采购',sender:'alice'},selected);assert.match(selected.files[0].path,/alice/);
 await assert.rejects(x.docs.run('send_document',{keyword:'/etc/passwd'},x.ctx()),/没有找到/);
 const y=setup(t);y.add();const ctx=y.ctx();await y.docs.run('send_document',{keyword:'采购'},ctx);assert.equal(ctx.files.length,1);assert.equal(ctx.files[0].documentAccessGeneration,y.docs.generation);
});
test('summary batches at most twenty and marks only that batch',async t=>{
 const x=setup(t);for(let i=0;i<21;i++)x.add('alice',`file${i}.docx`);
 const ctx=x.ctx();assert.match(await x.docs.run('summarize_inbox',{},ctx),/20份.*21份/);
 const result=await x.docs.buildSummary(ctx.documents[0],ctx.chatKey);x.docs.delivered(result);assert.equal(x.docs.inbox.stats().pending,1);
});
test('configuration fallback preserves closed empty lists, temperature zero and disabled wake words',()=>{
 const cfg=structuredClone(DEFAULTS);cfg.access.allowAllWhenEmpty=false;cfg.access.privateAllow=[];cfg.llm.temperature=0;cfg.llm.model='';cfg.llm.maxTokens=0;cfg.chat.group.wakeWords=[];
 normalizeConfig(cfg);assert.equal(cfg.access.allowAllWhenEmpty,false);assert.equal(cfg.llm.temperature,0);assert.deepEqual(cfg.chat.group.wakeWords,[]);assert.equal(cfg.llm.model,DEFAULTS.llm.model);assert.equal(cfg.llm.maxTokens,DEFAULTS.llm.maxTokens);
});
test('tool routing includes new file tools and document followups while preserving platform allowlist',()=>{
 const cfg=structuredClone(DEFAULTS),logger={info(){},warn(){},debug(){}};
 const tools=createTools({cfg,logger,office:{}});
 const names=tools.specsFor({requestText:'再发我一遍'}).map(s=>s.function.name);
 for(const name of ['forward_file','send_document','inbox_list','summarize_inbox','make_ppt','make_excel','make_docx'])assert.ok(names.includes(name));
 assert.ok(!names.includes('mc_connect'));
 const limited=createTools({cfg,logger,office:{},allowedTools:['make_excel']});assert.deepEqual(limited.specsFor({requestText:'我的世界'}).map(s=>s.function.name),['make_excel']);
});
