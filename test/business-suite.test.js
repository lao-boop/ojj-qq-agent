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
test('business benchmark stops paid requests on transport failure and resumes nested successes without answer leakage',async t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'whale-business-test-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 let count=0,healthy=false;
 const server=http.createServer(async(req,res)=>{
  let data='';for await(const chunk of req)data+=chunk;
  const input=JSON.parse(data),payload=JSON.parse(input.messages[1].content);count++;
  if(!healthy&&count>2){res.writeHead(503);res.end('temporary');return;}
  if(payload.stage==='questions')for(const q of payload.questions){assert.deepEqual(Object.keys(q).sort(),['id','options','question']);}
  const content=payload.stage==='questions'?'{"answers":[]}':wiringResponse(input,'本地测试替身，不代表理解。').content;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const config=path.join(temp,'config.json');fs.writeFileSync(config,JSON.stringify({llm:{apiKey:'local-test',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'local-test-only'}}));
 const env={...process.env};for(const k of ['DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])delete env[k];
 async function run(name,from){
  const out=path.join(temp,name),args=['scripts/evaluate-business-v4.mjs','--live','--config',config,'--out',out];if(from)args.push('--resume-from',from);
  const child=spawn(process.execPath,args,{cwd:root,env,stdio:'pipe'});let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
  const [code]=await once(child,'close');return {out,code,log,suite:JSON.parse(fs.readFileSync(path.join(out,'suite.json')))};
 }
 const first=await run('first');assert.equal(first.code,1,first.log);assert.equal(count,3);assert.equal(first.suite.units.filter(u=>u.status==='completed').length,2);
 healthy=true;const second=await run('second',first.out);assert.equal(second.code,0,second.log);assert.equal(second.suite.units.filter(u=>u.status==='completed').length,49);assert.equal(count,50);
 const interrupted=path.join(temp,'interrupted');fs.mkdirSync(interrupted);const partial={...second.suite,units:[]};fs.writeFileSync(path.join(interrupted,'suite.json'),JSON.stringify(partial));fs.cpSync(second.out,path.join(interrupted,'previous-attempt'),{recursive:true});
 const third=await run('third',interrupted);assert.equal(third.code,0,third.log);assert.equal(count,50,'No repeat paid calls after interrupted resume');assert.ok(third.suite.units.every(u=>u.reused));
 const metrics=JSON.parse(fs.readFileSync(path.join(second.out,'metrics.json')));assert.ok(metrics.rows.every(r=>r.correct===0&&r.questions===28));
});
