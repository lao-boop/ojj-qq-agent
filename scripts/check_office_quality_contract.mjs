// Offline diagnostic: deterministic outlines, real production Office/builders.
// This validates rendering contracts; it is NOT a model answer-quality score.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const out=path.resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||'tmp/office-quality-contract');fs.mkdirSync(out,{recursive:true});
process.env.QQBOT_DATA=path.join(out,'isolated-data');
const {Office}=await import('../src/office.js');
const python=path.resolve('.venv/bin/python');
const logger={info(){},warn(){}};
let page=0;
const llm={async chat({messages}){
  const system=messages[0].content;
  if(system.includes('PPT 大纲')){
    const n=Number(/这次只写 (\d+) 页/.exec(system)[1]);
    return {content:JSON.stringify({title:'固定大纲页数诊断',slides:Array.from({length:n},()=>({title:`正文${++page}`,bullets:['这是固定测试数据，不是模型回答'],imagePrompt:''}))})};
  }
  if(system.includes('中文写作者'))return {content:JSON.stringify({title:'固定大纲Word诊断',sections:[1,2,3].map(i=>({heading:`测试小节${i}`,paragraphs:['这是固定测试数据。']}))})};
  return {content:JSON.stringify({title:'固定库存数据诊断',sheets:[{name:'库存',columns:['品名','数量','单价'],rows:[['螺丝',0,2.5],['垫圈',-3,0],['密封圈',4,null]]}]})};
}};
const office=new Office({cfg:{},llm,logger,pythonPath:python});
const cases=[['ppt',()=>office.makePpt({topic:'总共5页，含封面和结尾',pages:5,withImages:false})],['docx',()=>office.makeDocx({topic:'3节',sections:3})],['excel',()=>office.makeExcel({topic:'原始库存',rows:3,columns:3,dataPolicy:'provided'})]];
const results=[];
for(const [kind,run] of cases){
  const doc=await run();const inspection=JSON.parse(execFileSync(python,['scripts/inspect_quality_artifact.py',kind,doc.file],{encoding:'utf8'}));
  const extension=kind==='ppt'?'pptx':kind==='excel'?'xlsx':'docx';
  const target=path.join(out,`fixed-outline.${extension}`);fs.copyFileSync(doc.file,target);
  let accepted;
  if(kind==='ppt')accepted=inspection.pageCount===5;
  else if(kind==='docx')accepted=inspection.paragraphs.filter(p=>/^Heading/.test(p.style)).length===3;
  else accepted=JSON.stringify(inspection.sheets[0].rows.slice(2))===JSON.stringify([['螺丝',0,2.5],['垫圈',-3,0],['密封圈',4,null]]);
  results.push({kind,accepted,expected:kind==='ppt'?'总共5页（含封面结尾）':kind==='docx'?'3个小节':'0、负数、空白及数值类型保持原样',
    deliveredName:doc.name,originalBasename:path.basename(doc.file),localFile:path.basename(target),inspection});
}
fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({mode:'offline-fixed-outline-not-model-quality',results},null,2));
console.log(JSON.stringify(results.map(({inspection,...r})=>({...r,actualPages:inspection.pageCount})),null,2));
if(results.some(r=>!r.accepted))process.exitCode=1;
