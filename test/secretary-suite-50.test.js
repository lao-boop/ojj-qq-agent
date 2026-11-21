import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {wiringResponse} from '../experiments/secretary/wiring-double.js';
const root=path.resolve(import.meta.dirname,'..');
const suite=JSON.parse(fs.readFileSync(path.join(root,'experiments/secretary/suite-v3-50.json')));
test('50-input suite retains ten actual prior inputs and isolates critical versus incidental changes',()=>{
 assert.equal(suite.reduce((n,c)=>n+c.variants.length,0),50);
 assert.equal(suite.filter(c=>c.variants.length===3).length,16);
 assert.equal(suite.filter(c=>c.variants.length===1).length,2);
 const old=[...JSON.parse(fs.readFileSync(path.join(root,'experiments/secretary/cases.json'))),...JSON.parse(fs.readFileSync(path.join(root,'experiments/secretary/fresh-v3.json')))];
 let known=0;
 for(const c of suite){
  assert.ok(c.review);for(const v of c.variants)assert.ok(c[v].length);
  if(c.cohort==='known-regression'){
   const before=old.find(x=>x.id===c.id);assert.deepEqual(c.history,before.history);
   for(const v of c.variants){assert.deepEqual(c[v],before[v]);known++;}
  }else if(c.variants.length===3){
   assert.equal(c.original.length,c.key.length);assert.equal(c.original.length,c.irrelevant.length);
   assert.equal(c.original.filter((s,i)=>s!==c.key[i]).length,1);
   assert.equal(c.original.filter((s,i)=>s!==c.irrelevant[i]).length,1);
  }
 }
 assert.equal(known,10);
});

test('50-input runner pauses after three failures and resumes only unfinished inputs',async t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'secretary-50-test-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 let requests=0,healthy=false;
 const server=http.createServer(async(req,res)=>{
  let data='';for await(const chunk of req)data+=chunk;
  const input=JSON.parse(data);assert.equal(JSON.parse(input.messages[1].content).stage,'direct');requests++;
  const content=healthy || requests<=2?wiringResponse(input,'测试替身，仅验证50输入续跑，不代表模型理解。').content:'{}';
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const config=path.join(tmp,'config.json');fs.writeFileSync(config,JSON.stringify({llm:{apiKey:'test-only',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'local-test-only'}}));
 const env={...process.env};for(const k of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[k];
 async function run(name,previous){
  const out=path.join(tmp,name),args=['scripts/evaluate-secretary-v3-50.mjs','--live','--config',config,'--out',out];if(previous)args.push('--resume-from',previous);
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'pipe'});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  const [code]=await once(child,'close');return {out,code,log,result:JSON.parse(fs.readFileSync(path.join(out,'results.json')))};
 }
 const first=await run('first');assert.equal(first.code,1,first.log);assert.equal(first.result.completed,2);assert.equal(first.result.failed,3);assert.equal(first.result.pending,45);assert.equal(requests,8);
 healthy=true;const second=await run('second',first.out);assert.equal(second.code,0,second.log);assert.equal(second.result.completed,50);assert.equal(second.result.rows.filter(r=>r.reused).length,2);assert.equal(requests,56);
 assert.ok(fs.existsSync(path.join(second.out,'previous-attempt','suite.json')));
 // Simulate a resume interrupted before visiting the remaining saved successes.
 const interrupted=path.join(tmp,'interrupted');fs.mkdirSync(interrupted);fs.copyFileSync(path.join(second.out,'suite.json'),path.join(interrupted,'suite.json'));fs.cpSync(second.out,path.join(interrupted,'previous-attempt'),{recursive:true});
 const third=await run('third',interrupted);assert.equal(third.code,0,third.log);assert.equal(third.result.completed,50);assert.ok(third.result.rows.every(r=>r.reused));assert.equal(requests,56,'No repeated paid calls when recovering nested partial attempts');
});
