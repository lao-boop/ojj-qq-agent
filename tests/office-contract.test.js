import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-contract-'));
process.env.QQBOT_DATA = root;
const { Office } = await import('../src/office.js');
const python = process.env.PYTHON_PATH || (fs.existsSync('.venv/bin/python') ? path.resolve('.venv/bin/python') : 'python3');
const logger = { info() {}, warn() {} };
const response = value => ({content: JSON.stringify(value)});
const slides = n => ({title:'主题',slides:Array.from({length:n},(_,i)=>({title:`第${i+1}项`,bullets:['只写已知事实']}))});
const inspect = (kind, file) => JSON.parse(execFileSync(python, ['scripts/inspect_quality_artifact.py',kind,file], {encoding:'utf8'}));
test.after(() => fs.rmSync(root,{recursive:true,force:true}));

for (const pages of [5,20]) test(`PPT actual package contains exactly ${pages} total slides, including cover and ending`,async()=>{
  const counts=[];
  const office=new Office({logger,pythonPath:python,llm:{chat:async request=>{
    const count=Number(/这次只写 (\d+) 页正文/.exec(request.messages[0].content)[1]);counts.push(count);return response(slides(count));
  }}});
  const result=await office.makePpt({topic:'只围绕既定主题',pages,withImages:false});
  assert.equal(inspect('ppt',result.file).pageCount,pages);
  assert.equal(result.pages,pages);assert.equal(counts.reduce((a,b)=>a+b,0),pages-2);
  assert.ok(result.name.endsWith(`-${pages}页.pptx`));
});

test('PPT wrong counts are repaired once, never silently trimmed into an apparent success',async()=>{
  let calls=0;
  const office=new Office({logger,pythonPath:python,llm:{chat:async()=>response(slides(++calls===1?4:3))}});
  const doc=await office.makePpt({topic:'三个主题',pages:5,withImages:false});
  assert.equal(calls,2);assert.equal(inspect('ppt',doc.file).pageCount,5);
  let failures=0;
  const broken=new Office({logger,pythonPath:python,llm:{chat:async()=>{failures++;return response(slides(4));}}});
  await assert.rejects(broken.makePpt({topic:'三个主题',pages:5,withImages:false}),/必须恰好3/);assert.equal(failures,2);
});

test('invalid total page count stops before requesting an outline',async()=>{
  const office=new Office({logger,llm:{chat:()=>{throw new Error('must not call');}}});
  await assert.rejects(office.makePpt({pages:4}),/总页数/);
});

test('Word accepts short grounded sections, preserves exact section count, and rejects empty padding',async()=>{
  const section={heading:'已知事实',paragraphs:['地点：书店。']};let calls=0;
  const office=new Office({logger,pythonPath:python,llm:{chat:async()=>response({title:'短材料',sections:++calls===1?[section]:[section,section,section]})}});
  const doc=await office.makeDocx({topic:'只整理给定事实',sections:3});
  const paragraphs=inspect('docx',doc.file).paragraphs;
  assert.equal(calls,2);assert.equal(paragraphs.filter(p=>p.style==='Heading 1').length,3);
  assert.equal(paragraphs.filter(p=>p.text==='地点：书店。').length,3);
  let failures=0;
  const broken=new Office({logger,pythonPath:python,llm:{chat:async()=>{failures++;return response({sections:Array(3).fill({heading:'空节',paragraphs:[]})});}}});
  await assert.rejects(broken.makeDocx({sections:3}),/空小节/);assert.equal(failures,2);
});

test('Excel uses xlsx on disk and preserves zeros, negatives and blank cells',async()=>{
  const rows=[['甲',0,2.5],['乙',-3,0],['丙',4,null]];
  const office=new Office({logger,pythonPath:python,llm:{chat:async()=>response({title:'原始数据',sheets:[{name:'库存',columns:['品名','数量','单价'],rows}]})}});
  const doc=await office.makeExcel({topic:'只整理原始数据',rows:3,columns:3,dataPolicy:'provided'});
  assert.equal(path.extname(doc.file),'.xlsx');assert.deepEqual(inspect('excel',doc.file).sheets[0].rows.slice(2),rows);
});
