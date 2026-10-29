import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfficeDelivery } from '../src/office-delivery.js';
import { ReplySender } from '../src/reply.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'office-delivery-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const file=path.join(root,'sample.docx');fs.writeFileSync(file,'test-doc');
const logger={info(){},warn(){}};
const chat={key:'private:10',type:'private',userId:10,title:'test'};
function setup(mode){
  const calls=[],events=[],notes=[];
  const onebot={async call(action){calls.push(action);if(mode==='timeout')throw new Error('timeout');if(mode==='reject')throw Object.assign(new Error('rejected'),{deliveryState:'rejected'});return {file_id:'ok'};},async sendPrivate(){},async sendGroup(){}};
  const sender=new ReplySender({onebot,logger,cfg:{firstDelayMs:[0,0],splitDelayMs:[0,0]}});
  const office={async makeDocx(){if(mode==='generate-fail')throw new Error('generation error');return {file,name:'sample.docx'};}};
  const journal=path.join(root,`${mode}.json`);
  const service=new OfficeDelivery({office,sender,logger,file:journal,memory:{append(...a){notes.push(a);}},onState:r=>events.push(r.status)});
  return {service,calls,events,notes,journal};
}
test('generation, upload and confirmed receipt have distinct durable phases',async()=>{
  const f=setup('ok'),r=await f.service.run(chat,{kind:'docx',topic:'test'});
  assert.equal(r.ok,true);assert.equal(r.status,'sent');assert.deepEqual(f.events,['queued','generating','generated','sending','sent']);
  assert.deepEqual(f.calls,['upload_private_file']);assert.match(f.notes[0][2],/接口已确认上传/);
});
for(const [mode,expected] of [['reject','send_failed'],['timeout','delivery_unknown']])test(`${mode} preserves the generated file and never retries or falls back to voice`,async()=>{
  const f=setup(mode),r=await f.service.run(chat,{kind:'docx',topic:'test'});
  assert.equal(r.status,expected);assert.ok(fs.existsSync(r.file));assert.deepEqual(f.calls,['upload_private_file']);
  assert.doesNotMatch(f.notes[0][2],/生成失败|已发给/);
});
test('generation failure never reaches the upload adapter',async()=>{
  const f=setup('generate-fail'),r=await f.service.run(chat,{kind:'docx'});assert.equal(r.status,'generation_failed');assert.deepEqual(f.calls,[]);
});
test('restart marks an in-flight upload unknown without sending again',()=>{
  const file=path.join(root,'interrupted.json');fs.writeFileSync(file,JSON.stringify([{id:'j',chatKey:'private:10',status:'sending'}]));
  const service=new OfficeDelivery({file,logger,sender:{sendFile(){assert.fail('must not retry');}}});
  assert.equal(service.visible('private:10')[0].status,'delivery_unknown');assert.equal(service.visible('private:11').length,0);
});
test('failed status notification or media indexing cannot turn a confirmed upload into failure',async()=>{
  const f=setup('callback');f.service.sender.send=async()=>{throw new Error('text failure');};f.service.onSent=()=>{throw new Error('index failure');};
  const r=await f.service.run(chat,{kind:'docx'});assert.equal(r.status,'sent');assert.equal(f.calls.length,1);
});
