import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'large-file-test-'));
process.env.QQBOT_DATA=data;
const {FileReader}=await import('../src/files.js');
after(()=>fs.rmSync(data,{recursive:true,force:true}));
const logger={info(){},warn(){}};
test('QQ file intake accepts 25MB files and rejects files over 100MB',async()=>{
 const source=path.join(data,'large.pptx');fs.writeFileSync(source,'');fs.truncateSync(source,25*1024*1024);
 const reader=new FileReader({cfg:{},logger});const downloaded=await reader.download(null,{file:source,name:'deck.pptx'});
 assert.equal(downloaded.size,25*1024*1024);assert.equal(fs.statSync(downloaded.path).size,downloaded.size);
 fs.truncateSync(source,101*1024*1024);await assert.rejects(reader.download(null,{file:source,name:'deck.pptx'}),/100MB/);
});
test('oversized HTTP content is rejected before buffering or storing it',async t=>{
 const old=globalThis.fetch;let canceled=false;
 globalThis.fetch=async()=>({ok:true,headers:new Headers({'content-length':String(101*1024*1024)}),body:{async cancel(){canceled=true;}}});
 t.after(()=>globalThis.fetch=old);
 const before=fs.readdirSync(path.join(data,'files'));
 await assert.rejects(new FileReader({cfg:{},logger}).download(null,{url:'https://example.invalid/huge',name:'huge.pdf'}),/100MB/);
 assert.ok(canceled);assert.deepEqual(fs.readdirSync(path.join(data,'files')),before);
});

test('real summary Word renderer preserves overview, submitter, timestamp and numeric facts',async()=>{
 const {Office}=await import('../src/office.js');
 const {spawnSync}=await import('node:child_process');
 const python=process.env.OFFICE_TEST_PYTHON || 'python3';
 const office=new Office({cfg:{pythonPath:python},llm:{},imageGen:{},logger});
 const built=await office.makeSummaryDocx({title:'文档汇总验收',subtitle:'两份文档',sections:[
  {heading:'总体概览',paragraphs:['采购预算500元，活动改为周五，场地仍待确认。']},
  {heading:'采购方案.docx（小林）',paragraphs:['收到于 2026-11-17 10:00 +08:00','预算500元。']},
  {heading:'活动安排.docx（小陈）',bullets:['由周四改为周五。','场地尚未确认。']},
 ]});
 const r=spawnSync(python,['-c','import sys; from docx import Document; print("\\n".join(p.text for p in Document(sys.argv[1]).paragraphs))',built.file],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);for(const value of ['总体概览','500元','小林','2026-11-17','周五','场地尚未确认'])assert.ok(r.stdout.includes(value),value);
});
