import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
const roots=[process.argv[2]||'/workspace/scratch/ojj-before-task-reliability',process.argv[3]||process.cwd()];
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'compare-reliability-')),results=[];
try {
 for(const [index,root] of roots.entries()) {
  const {Memory}=await import(pathToFileURL(path.join(root,'src/memory.js')));
  const {TaskState}=await import(pathToFileURL(path.join(root,'src/agents/understanding.js')));
  let now=Date.parse('2026-11-15T01:00:00Z');const m=new Memory({directory:path.join(temp,`memory-${index}`),now:()=>now,cfg:{historyTurns:60,expandQuery:false},logger:{}});
  m.addNote('k','临时集合点为栈桥东侧',null,{scope:'temporary',expiresAt:'2026-11-15T01:01:00Z',requestId:'source'});
  m.append('k','user','临时集合点为栈桥东侧',null,{requestId:'source'});now+=120000;
  for(let i=0;i<45;i++)m.addNote('k',`资料架编号${i}`);
  const expiredResurfaced=m.context('k').turns.some(t=>t.content.includes('栈桥东侧'));
  const file=path.join(temp,`tasks-${index}.json`);const state=new TaskState({file});state.add('k',{goal:'保留待执行草稿',operations:['document.create'],slots:{topic:'冬青护理'},requester:'11'});
  const draftRestored=new TaskState({file}).list('k').length===1;
  const timers=new Map(),emitted=[];let n=0;
  const setTimer=fn=>{timers.set(++n,fn);return n;},clearTimer=id=>timers.delete(id);
  let enqueue;
  if(fs.existsSync(path.join(root,'src/file-batches.js'))) {
   const {FileBatches}=await import(pathToFileURL(path.join(root,'src/file-batches.js')));
   const batches=new FileBatches({emit:e=>emitted.push(e),setTimer,clearTimer});enqueue=(key,e)=>batches.enqueue(key,e);
  } else {
   const source=fs.readFileSync(path.join(root,'src/index.js'),'utf8'),start=source.indexOf('function enqueueFiles('),end=source.indexOf('\nfunction enqueueBatch(',start);
   const sandbox={pendingFiles:new Map(),setTimeout:setTimer,clearTimeout:clearTimer,onMessage:e=>{emitted.push(e);return Promise.resolve();},logger:{warn(){}}};vm.createContext(sandbox);vm.runInContext(`${source.slice(start,end)}\nglobalThis.enqueue=enqueueFiles;`,sandbox);enqueue=(key,e)=>sandbox.enqueue(key,e,e.message);
  }
  for(const actor of [11,22])enqueue('group:9',{user_id:actor,message:[{type:'file',data:{name:`${actor}.txt`}}]});
  for(const fn of timers.values())fn();await new Promise(r=>setImmediate(r));
  results.push({version:index?'after':'before',sourceRoot:root,expiredFactRemainsHidden:!expiredResurfaced,draftRestored,filesRemainWithTheirSenders:emitted.length===2&&emitted.every(e=>e.message.every(s=>s.data.name===`${e.user_id}.txt`)),fileEvents:emitted.map(e=>({actor:e.user_id,files:e.message.map(s=>s.data.name)}))});
 }
 fs.mkdirSync('tmp',{recursive:true});fs.writeFileSync('tmp/task-reliability-mechanism-comparison.json',JSON.stringify({scope:'Same deterministic regressions against actual old/new code, no model calls or real QQ messages',results},null,2));console.log(JSON.stringify(results,null,2));
} finally {fs.rmSync(temp,{recursive:true,force:true});}
