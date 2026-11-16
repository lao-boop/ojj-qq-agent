import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WeComDirectory, messageTimes, validateContacts } from '../src/wecom-directory.js';
const response = body => ({ ok: true, json: async () => body });
function fixture(t, fetchImpl, patch = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-directory-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-16T00:00:00Z');
  const cfg = {wecom:{botId:'bot',corpId:'corp',directorySecret:'fixture-secret',directoryEnabled:true,contacts:[],...patch}};
  const directory = new WeComDirectory({cfg,dataDir,fetchImpl,now:()=>now});
  return {directory,cfg,dataDir,advance:ms=>now+=ms};
}
test('read-only directory resolves names and departments, coalesces lookups and excludes sensitive fields from disk', async t => {
  const calls=[];
  const x=fixture(t,async url=>{
    calls.push(url.pathname);
    if(url.pathname.endsWith('gettoken'))return response({access_token:'fixture-token',expires_in:7200});
    if(url.pathname.endsWith('user/get'))return response({userid:'alice',name:'张三',department:[2],position:'经理',mobile:'do-not-store-phone',email:'do-not-store-email'});
    return response({department:[{id:2,name:'销售部'}]});
  });
  const [a,b]=await Promise.all([x.directory.resolve('alice'),x.directory.resolve('alice')]);
  assert.equal(a.name,'张三'); assert.equal(b.department,'销售部'); assert.equal(a.source,'企业通讯录');
  assert.equal(calls.length,3); await x.directory.resolve('alice'); assert.equal(calls.length,3);
  const disk=fs.readFileSync(x.directory.file,'utf8');
  assert.doesNotMatch(disk,/fixture-token|fixture-secret|do-not-store/);
  const restored=new WeComDirectory({cfg:x.cfg,dataDir:x.dataDir,fetchImpl:()=>assert.fail('fresh cache makes no requests'),now:()=>Date.parse('2026-11-16T00:01:00Z')});
  assert.equal((await restored.resolve('alice')).name,'张三');
});
test('manual verified roster works without credentials; unknown users and chat claims never invent names',async t=>{
  const x=fixture(t,()=>assert.fail('manual mode makes no requests'),{directoryEnabled:false,contacts:[{userId:'alice',name:'张三',department:'销售部'}]});
  assert.equal((await x.directory.resolve('alice')).source,'管理员名单');
  assert.equal((await x.directory.resolve('unknown')).name,'');
  assert.throws(()=>validateContacts({contacts:[{userId:'x',name:'甲'},{userId:'x',name:'乙'}]}),/重复/);
});
test('expired tokens refresh once and optional department failures retain verified names',async t=>{
  let tokens=0,users=0;
  const x=fixture(t,async url=>{
    if(url.pathname.endsWith('gettoken')){tokens++;return response({access_token:'t'+tokens});}
    if(url.pathname.endsWith('user/get'))return response(++users===1?{errcode:42001}:{userid:'alice',name:'张三',department:[2]});
    return response({errcode:48002});
  });
  assert.equal((await x.directory.resolve('alice')).department,'部门ID 2');assert.equal(tokens,2);assert.equal(users,2);
});
test('permission/network failures preserve user ID, redact details and avoid retry storms',async t=>{
  let calls=0;
  const x=fixture(t,async()=>{calls++;throw new Error('url?corpsecret=do-not-expose');});
  assert.equal((await x.directory.resolve('alice')).name,'');
  await x.directory.resolve('bob');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(x.directory.status()),/do-not-expose/);
});
test('late responses after credential changes never contaminate the new directory scope',async t=>{
  let finish;
  const x=fixture(t,()=>new Promise(resolve=>{finish=resolve;}));
  const pending=x.directory.resolve('alice');
  x.cfg.wecom.corpId='new-corp';x.directory.updateConfig(x.cfg);
  finish(response({access_token:'old-token'}));
  assert.equal((await pending).name,'');assert.equal(x.directory.cache.size,0);assert.equal(x.directory.token,null);
});
test('missing and malformed platform timestamps stay unknown, reception time is never rewritten',()=>{
  const now=Date.parse('2026-11-16T00:00:00Z');
  assert.deepEqual(messageTimes({create_time:(now-10000)/1000},now),{platformAt:now-10000,receivedAt:now});
  for(const v of [undefined,0,-1,now,'yesterday',(now+3600000)/1000])assert.equal(messageTimes({create_time:v},now).platformAt,null);
});

test('expired cached names are explicitly stale when permission is lost and a mismatched userid cannot replace them',async t=>{
  let denied=false;
  const x=fixture(t,async url=>{
    if(url.pathname.endsWith('gettoken'))return response({access_token:'fixture-token'});
    if(url.pathname.endsWith('user/get'))return response(denied?{userid:'someone-else',name:'错误姓名'}:{userid:'alice',name:'张三',department:[]});
    return response({department:[]});
  });
  await x.directory.resolve('alice');x.advance(3600001);denied=true;
  const p=await x.directory.resolve('alice');
  assert.equal(p.name,'张三');assert.equal(p.stale,true);assert.match(x.directory.status().lastError,/匹配/);
});
