import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory, memoryScopeKey } from '../src/memory.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-life-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const create=(name,now=()=>100000)=>new Memory({directory:path.join(root,name),now,logger:{info(){},warn(){}},cfg:{historyTurns:40,storeAllTurns:true,expandQuery:false}});

test('updates replace a fact after restart and suppress previous source and derived answers',async()=>{
  let m=create('update');m.addNote('a','默认部门是设计组',null,{requestId:'write'});
  const old=m.context('a').noteRecords[0];
  m.append('a','user','保存默认部门是设计组',null,{requestId:'write'});
  m.append('a','assistant','你在设计组',null,{requestId:'recall',memoryIds:[old.id]});
  m.addNote('a','常用语言是中文',null,{requestId:'other'});
  m.updateNote('a',old.id,'默认部门是研究组',{requestId:'change'});
  m=create('update');assert.deepEqual(m.context('a').notes,['默认部门是研究组','常用语言是中文']);
  assert.equal(m.context('a').turns.length,0);assert.equal((await m.search('a','设计组')).length,0);
});
test('expiring notes and dependent recalled text cannot return through context or search',async()=>{
  let now=Date.parse('2026-12-01T00:00:00Z');const m=create('expiry',()=>now);
  m.addNote('a','临时工位是东区9号',null,{scope:'temporary',expiresAt:'2026-12-01T10:00:00+08:00',requestId:'write'});
  const id=m.context('a').noteRecords[0].id;
  m.append('a','assistant','东区9号',null,{requestId:'read',memoryIds:[id]});
  assert.equal(m.context('a').notes.length,1);
  now=Date.parse('2026-12-01T02:00:00Z');assert.deepEqual(m.context('a').notes,[]);assert.deepEqual(m.context('a').turns,[]);assert.deepEqual(await m.search('a','东区9号'),[]);
});
test('forget removes exact selected note, retains others, and hides deletion wording',async()=>{
  const m=create('forget');m.addNote('a','旧部门',null,{requestId:'old'});m.addNote('a','周末偏好散步',null,{requestId:'other'});
  const id=m.context('a').noteRecords[0].id;m.forgetNote('a',id,{requestId:'forget'});
  m.append('a','user','忘掉旧部门',null,{requestId:'forget'});
  assert.deepEqual(m.context('a').notes,['周末偏好散步']);assert.deepEqual(await m.search('a','旧部门'),[]);
});
test('group member storage and record IDs cannot cross actor boundaries',()=>{
  const m=create('owners'),a=memoryScopeKey('group:41','7'),b=memoryScopeKey('group:41','8');
  m.addNote(a,'称呼阿越');const id=m.context(a).noteRecords[0].id;
  assert.deepEqual(m.context(b).notes,[]);assert.throws(()=>m.updateNote(b,id,'盗改'),/没有找到/);assert.throws(()=>m.forgetNote(b,id),/没有找到/);
  assert.deepEqual(m.context(a).notes,['称呼阿越']);assert.equal(memoryScopeKey('private:7','7'),'private:7');
});
test('temporary notes need a future explicit timezone, and long records are not truncated',()=>{
  const m=create('invalid');for(const expiresAt of [undefined,'tomorrow','2026-01-01T10:00:00','1970-01-01T00:00:01Z'])assert.throws(()=>m.addNote('a','地点',undefined,{scope:'temporary',expiresAt}));
  assert.throws(()=>m.addNote('a','x'.repeat(601)),/过长/);
  assert.deepEqual(m.context('a').notes,[]);
});
test('migrates legacy notes without discarding their text',()=>{
  const m=create('legacy'),s=m.get('a');s.notes=[{text:'历史备注',ts:10}];m.save(s);
  const reloaded=create('legacy');assert.equal(reloaded.context('a').notes[0],'历史备注');assert.ok(reloaded.context('a').noteRecords[0].id);
});
