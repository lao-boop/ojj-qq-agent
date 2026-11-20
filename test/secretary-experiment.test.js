import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {requestFailure,expectAckLoss,checkResume,reuseCompleted} from '../experiments/secretary/support.js';
import {writeScheduledBriefing} from '../src/wecom-scheduled-briefing.js';
const run=promisify(execFile);
const root=path.resolve(import.meta.dirname,'..');

test('ACK-loss test preserves the original network or validation error',async()=>{
  const sentinel=new Error('Synthetic ACK lost');
  const network=new TypeError('fetch failed',{cause:Object.assign(new Error('private URL'),{code:'ECONNRESET'})});
  await expectAckLoss(async()=>{throw sentinel;},sentinel);
  await assert.rejects(expectAckLoss(async()=>{throw network;},sentinel),e=>e===network);
  await assert.rejects(expectAckLoss(async()=>{},sentinel),/did not attempt delivery/);
});

test('request diagnostics retain safe nested codes without URLs or credentials',()=>{
  const cause=Object.assign(new Error('secret-token https://user:password@proxy'),{code:'ECONNREFUSED',address:'private-proxy'});
  const error=new TypeError('fetch failed',{cause:new AggregateError([cause])});
  const details=requestFailure(error);
  assert.equal(details.kind,'model_transport');
  assert.ok(details.causes.some(c=>c.code==='ECONNREFUSED'));
  assert.doesNotMatch(JSON.stringify(details),/secret|password|private-proxy/);
  assert.equal(requestFailure(Object.assign(new Error('secret'),{status:401})).message,'HTTP 401');
  assert.equal(requestFailure(Object.assign(new Error('secret'),{name:'TimeoutError'})).kind,'model_timeout');
});

test('resume rejects changed algorithm, model, mode or production files',()=>{
  const keys=['src/wecom-secretary.js','src/wecom-briefing.js','src/wecom-scheduled-briefing.js','experiments/secretary/baseline-briefing.js','experiments/secretary/cases.json'];
  const m={mode:'real-model',algorithm:'upgraded',split:'dev',model:'test',baselineCommit:'abc',files:Object.fromEntries(keys.map(k=>[k,'hash']))};
  assert.doesNotThrow(()=>checkResume(m,structuredClone(m)));
  for(const key of ['algorithm','model','mode']) assert.throws(()=>checkResume(m,{...m,[key]:'changed'}));
  assert.throws(()=>checkResume(m,{...m,files:{...m.files,[keys[0]]:'changed'}}));
});

test('resume copies only complete results and preserves the old bytes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resume-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const from=path.join(dir,'old'),to=path.join(dir,'new');fs.mkdirSync(from);fs.mkdirSync(to);
  const m={results:[{id:'good',status:'completed'},{id:'bad',status:'failed'}]};
  for(const suffix of ['.json','-calls.json','-archive.jsonl'])fs.writeFileSync(path.join(from,'good'+suffix),'saved exact bytes');
  assert.equal(reuseCompleted(m,from,to,'good'),true);
  assert.equal(reuseCompleted(m,from,to,'bad'),false);
  for(const file of fs.readdirSync(from))assert.equal(fs.readFileSync(path.join(from,file),'utf8'),fs.readFileSync(path.join(to,file),'utf8'));
});

const snapshots=JSON.parse(fs.readFileSync(new URL('./fixtures/secretary-mac-responses.json',import.meta.url)));
for(const fixture of snapshots)test(`Mac response replay: ${fixture.id} passes existing guards without relaxing them`,async()=>{
  let count=0;
  const r=await writeScheduledBriefing({messages:fixture.messages,llm:{async chat(){return fixture.responses[count++];}}});
  assert.equal(count,2);assert.ok(r.text);assert.ok(r.sources.length);
});

test('model HTTP failure stops a batch, records phase and archive, and is not mislabeled as ACK failure',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'experiment-http-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let requests=0;
  const server=http.createServer((req,res)=>{requests++;res.writeHead(401);res.end('private token must not be saved');});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const config=path.join(dir,'config.json'),out=path.join(dir,'results');
  fs.writeFileSync(config,JSON.stringify({llm:{model:'test',apiKey:'dummy',baseUrl:`http://127.0.0.1:${server.address().port}/v1`}}));
  const env={...process.env,DEEPSEEK_API_KEY:'dummy',DEEPSEEK_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,NO_PROXY:'127.0.0.1',no_proxy:'127.0.0.1'};
  await assert.rejects(run(process.execPath,['scripts/experiment-secretary.mjs','--live','--algorithm','upgraded','--config',config,'--out',out],{cwd:root,env}),e=>e.code===2);
  const m=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));
  assert.equal(requests,1);assert.equal(m.results[0].kind,'model_http');assert.equal(m.results[0].phase,'current-generation');
  assert.equal(m.results[0].error,'HTTP 401');assert.equal(m.results.filter(r=>r.status==='not-run').length,8);
  assert.ok(fs.existsSync(path.join(out,'renewal-original-archive.jsonl')));
  const calls=fs.readFileSync(path.join(out,'renewal-original-calls.json'),'utf8');
  assert.doesNotMatch(calls,/private token|dummy|Synthetic ACK/);
  assert.equal(JSON.parse(calls)[0].attempts,1);
  await run(process.execPath,['scripts/compare-secretary.mjs',dir],{cwd:root});
});
