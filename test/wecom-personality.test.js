import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ensureWecomPersona, LEGACY_WECOM_PERSONA, DEFAULT_WECOM_PERSONA} from '../src/wecom-personality.js';
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'wecom-persona-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('fresh persona uses conversational default and keeps the shipped asset in sync',t=>{
 const d=dir(t);const file=ensureWecomPersona(d);assert.equal(fs.readFileSync(file,'utf8'),DEFAULT_WECOM_PERSONA);
 assert.equal(fs.readFileSync(new URL('../assets/persona.wecom.default.md',import.meta.url),'utf8'),DEFAULT_WECOM_PERSONA);
});
test('exact former default is backed up and migrated once',t=>{
 const d=dir(t);fs.writeFileSync(path.join(d,'persona.wecom.md'),LEGACY_WECOM_PERSONA);
 const file=ensureWecomPersona(d);assert.equal(fs.readFileSync(file,'utf8'),DEFAULT_WECOM_PERSONA);
 assert.equal(fs.readFileSync(path.join(d,'persona.wecom.before-conversation-update.md'),'utf8'),LEGACY_WECOM_PERSONA);
 ensureWecomPersona(d);assert.equal(fs.readdirSync(d).length,2);
});
test('custom and deliberately empty personas remain byte-for-byte unchanged',t=>{
 for(const custom of ['自定义人格：我是小蓝，说话干脆。\n',LEGACY_WECOM_PERSONA+'\n我喜欢讲笑话。','']){
  const d=dir(t);fs.writeFileSync(path.join(d,'persona.wecom.md'),custom);
  assert.equal(fs.readFileSync(ensureWecomPersona(d),'utf8'),custom);assert.equal(fs.readdirSync(d).length,1);
 }
});
