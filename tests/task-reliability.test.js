import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileBatches } from '../src/file-batches.js';
import { Memory } from '../src/memory.js';
import { TaskState } from '../src/task-state.js';
import { TaskControl } from '../src/task-control.js';
import { OfficeDelivery } from '../src/office-delivery.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-reliability-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const logger={warn(){},info(){}};
const chat={key:'group:812',type:'group',groupId:812};
const job={kind:'docx',topic:'木刻材料归档',requester:'61',taskId:'primary-task'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(name) {
  const directory=path.join(root,name);fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'actual.docx');fs.writeFileSync(file,'unchanged file bytes');
  const taskFile=path.join(directory,'tasks.json'),deliveryFile=path.join(directory,'deliveries.json');
  let state=new TaskState({file:taskFile}), generated=0, uploads=0, mode='accepted';
  const office={async makeDocx(){generated++;return {file,name:'实际产物.docx'};}};
  const sender={async send(){},async sendFile(c,f){uploads++;assert.equal(f,file);if(mode==='rejected')throw Object.assign(new Error('rejected'),{deliveryState:'rejected'});if(mode==='unknown')throw new Error('timeout');return {accepted:true,receipt:{file_id:'receipt'}};}};
  const makeDelivery=()=>new OfficeDelivery({office,sender,logger,file:deliveryFile,onState:r=>state.syncDelivery(r)});
  let delivery=makeDelivery();
  return {file,taskFile,deliveryFile,office,sender,get state(){return state;},get delivery(){return delivery;},get generated(){return generated;},get uploads(){return uploads;},set mode(v){mode=v;},restart(){state=new TaskState({file:taskFile});delivery=makeDelivery();},control(){return new TaskControl({state,delivery,logger});}};
}

test('interleaved group attachments keep both actors and @/reply segments',async()=>{
  const timers=new Map(),out=[];let n=0;
  const batches=new FileBatches({emit:e=>out.push(e),setTimer:f=>{timers.set(++n,f);return n;},clearTimer:id=>timers.delete(id)});
  const event=(actor,name)=>({user_id:actor,message:[{type:'at',data:{qq:'900'}},{type:'reply',data:{id:name}},{type:'file',data:{name}}]});
  batches.enqueue('group:8',event(1,'A'));batches.enqueue('group:8',event(2,'B'));batches.enqueue('group:8',event(1,'C'));
  for(const fn of timers.values())fn();await tick();
  assert.equal(out.length,2);
  assert.deepEqual(out.find(e=>e.user_id===1).message.filter(s=>s.type==='file').map(s=>s.data.name),['A','C']);
  assert.deepEqual(out.find(e=>e.user_id===2).message.map(s=>s.type),['at','reply','file']);
});
test('permanent memory beyond forty survives restart and queries select the oldest relevant fact',()=>{
  const directory=path.join(root,'capacity'),cfg={historyTurns:40,expandQuery:false};
  let m=new Memory({directory,cfg,logger});m.addNote('k','鲸尾项目色标为赭红');
  for(let i=0;i<110;i++)m.addNote('k',`货架 ${i} 号存放纸箱`);
  m=new Memory({directory,cfg,logger});const c=m.context('k',{query:'鲸尾项目色标'});
  assert.equal(c.noteCount,111);assert.equal(c.notes.length,40);assert.equal(c.notesPartial,true);assert.equal(c.notes[0],'鲸尾项目色标为赭红');
  assert.equal(m.searchNotes('k','鲸尾项目').records[0].text,'鲸尾项目色标为赭红');
});
test('expired provenance survives many writes and restarts without resurrecting source or derived replies',async()=>{
  const directory=path.join(root,'tombstones'),cfg={historyTurns:40,expandQuery:false};let now=100000;
  let m=new Memory({directory,cfg,logger,now:()=>now});m.addNote('k','临时柜号为九号',null,{scope:'temporary',expiresAt:new Date(now+1000).toISOString(),requestId:'source'});
  const id=m.context('k').noteRecords[0].id;m.append('k','user','临时柜号为九号',null,{requestId:'source'});m.append('k','assistant','临时柜号为九号',null,{requestId:'derived',memoryIds:[id]});now+=2000;
  for(let i=0;i<70;i++)m.addNote('k',`新便签 ${i}`);
  m=new Memory({directory,cfg,logger,now:()=>now});assert.deepEqual(m.context('k').turns,[]);assert.deepEqual(await m.search('k','临时柜号'),[]);
  const persisted=JSON.parse(fs.readFileSync(m.fileFor('k')));assert.ok(persisted.retiredNoteIds.includes(id));assert.ok(!persisted.notes.some(n=>n.id===id));
});
test('drafts, changed slots and cancellation persist without evicting unfinished tasks',()=>{
  const f=fixture('drafts');const task=f.state.add(chat.key,{operations:['document.create'],requester:'61',slots:{topic:'旧主题'},exclude:[]});
  task.slots={topic:'新主题',format:'docx'};f.state.finish(task,'draft');
  for(let i=0;i<30;i++)f.state.add(chat.key,{operations:['document.create'],requester:'62',slots:{topic:`草稿${i}`}});
  f.restart();const restored=f.state.visible(chat.key,'61')[0];assert.equal(restored.slots.topic,'新主题');assert.equal(restored.status,'draft');
  assert.match(f.control().handle(chat,'61',`/cancel ${restored.id.slice(0,8)}`),/已取消/);f.restart();assert.equal(f.state.visible(chat.key,'61')[0].status,'cancelled');
});
test('a corrupt task journal fails closed without replacing its contents',()=>{
  const file=path.join(root,'corrupt.json');fs.writeFileSync(file,'broken');assert.throws(()=>new TaskState({file}));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('queue cancellation prevents generation and upload while another job is running',async()=>{
  const f=fixture('cancel');let release;f.office.makeDocx=()=>new Promise(resolve=>{release=()=>resolve({file:f.file,name:'one.docx'});});
  const first=f.delivery.run(chat,job);await tick();const second=f.delivery.run(chat,{...job,taskId:'second-task',topic:'第二份'});
  const secondRecord=f.delivery.records[1];assert.equal(secondRecord.status,'queued');
  assert.match(f.control().cancel(f.state.list(chat.key).find(t=>t.id==='second-task'),chat.key,'61'),/已取消/);
  assert.equal((await second).status,'cancelled');release();await first;assert.equal(f.uploads,1);assert.equal(f.state.list(chat.key).find(t=>t.id==='second-task').status,'cancelled');
});
test('restart keeps unstarted jobs paused until explicit resume',async()=>{
  const f=fixture('paused');const rec={id:'queued-id',taskId:'queued-task',requester:'61',chatKey:chat.key,chat,kind:'docx',topic:job.topic,job,status:'queued'};
  fs.writeFileSync(f.deliveryFile,JSON.stringify([rec]));f.restart();await tick();assert.equal(f.generated,0);assert.equal(f.delivery.records[0].status,'paused');
  const resumed=f.delivery.resume(rec.id,chat.key,'61');assert.equal(resumed.ok,true);await resumed.completion;assert.equal(f.generated,1);assert.equal(f.uploads,1);
});
test('restart preserves a generated file and resumes from upload only',async()=>{
  const f=fixture('generated');fs.writeFileSync(f.deliveryFile,JSON.stringify([{id:'ready',taskId:'ready-task',requester:'61',chatKey:chat.key,chat,job,status:'generated',file:f.file,name:'ready.docx'}]));
  f.restart();const resumed=f.delivery.resume('ready',chat.key,'61');await resumed.completion;assert.equal(f.generated,0);assert.equal(f.uploads,1);
});
test('explicit retry after rejection reuses original bytes and concurrent duplicate retry is rejected',async()=>{
  const f=fixture('retry');f.mode='rejected';const first=await f.delivery.run(chat,job);const bytes=fs.readFileSync(f.file);f.restart();f.mode='accepted';
  const a=f.delivery.resume(first.id,chat.key,'61',{retryOnly:true}),b=f.delivery.resume(first.id,chat.key,'61',{retryOnly:true});
  assert.equal(a.ok,true);assert.equal(b.ok,false);assert.equal((await a.completion).status,'sent');assert.equal(f.generated,1);assert.equal(f.uploads,2);assert.deepEqual(fs.readFileSync(f.file),bytes);
  assert.equal(f.state.list(chat.key)[0].status,'completed');
});
test('unknown upload remains blocked after restart and never triggers an automatic resend',async()=>{
  const f=fixture('unknown');f.mode='unknown';const first=await f.delivery.run(chat,job);f.restart();
  assert.equal(f.delivery.resume(first.id,chat.key,'61').ok,false);assert.equal(f.delivery.resume(first.id,chat.key,'61',{retryOnly:true}).ok,false);
  assert.equal(f.uploads,1);assert.equal(f.state.list(chat.key)[0].status,'interrupted');
});
test('task controls do not expose or mutate another member even with a known identifier',async()=>{
  const f=fixture('owner');f.mode='rejected';const result=await f.delivery.run(chat,job),control=f.control();
  assert.match(control.handle(chat,'62','/tasks'),/没有任务/);assert.match(control.handle(chat,'62','/retry primary-task'),/用 \/tasks/);
  assert.equal(f.delivery.resume(result.id,chat.key,'62').ok,false);assert.equal(f.delivery.cancel(result.id,chat.key,'62').ok,false);assert.equal(f.uploads,1);
});
test('missing saved artifact cannot turn retry into implicit regeneration',async()=>{
  const f=fixture('missing');f.mode='rejected';const first=await f.delivery.run(chat,job);fs.unlinkSync(f.file);
  assert.match(f.delivery.resume(first.id,chat.key,'61',{retryOnly:true}).reply,/原文件已不存在/);assert.equal(f.generated,1);assert.equal(f.uploads,1);
});
test('identical job re-entry is deduplicated but two distinct files share an accurate task status',async()=>{
  const f=fixture('dedup');await f.delivery.run(chat,job);await f.delivery.run(chat,job);assert.equal(f.generated,1);
  f.mode='rejected';await f.delivery.run(chat,{...job,topic:'第二份不同主题'});assert.equal(f.generated,2);
  const task=f.state.list(chat.key)[0];assert.equal(Object.keys(task.deliveries).length,2);assert.equal(task.status,'failed');assert.match(f.control().describe(task),/接口已确认上传/);assert.match(f.control().describe(task),/上传被拒绝/);
});
test('a delivered file cannot hide unfinished or interrupted work in a mixed task',()=>{
  const f=fixture('mixed'),task=f.state.add(chat.key,{requester:'61',operations:['document.create','music.compose'],slots:{topic:'混合任务'}});
  f.state.background(task,'running');f.state.syncDelivery({id:'doc-id',taskId:task.id,chatKey:chat.key,requester:'61',name:'one.docx',status:'sent'});
  assert.equal(task.status,'running');f.restart();const restored=f.state.list(chat.key).find(t=>t.id===task.id);assert.equal(restored.status,'interrupted');
  f.state.syncDelivery({id:'doc-id',taskId:task.id,chatKey:chat.key,requester:'61',name:'one.docx',status:'sent'});assert.equal(restored.status,'interrupted');
  f.state.background(restored,'failed');assert.equal(restored.status,'failed');
});
