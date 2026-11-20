import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {exportPrivate,inspectTransfer,makeOwnerConfig,installOwner} from '../scripts/friend-handover.mjs';
import {allowedPrivate} from '../src/access.js';

const settings={ownerQQ:'20002',ownerName:'新测试员',baseUrl:'https://example.invalid/v1',model:'test-model',apiKey:'test-api-key',wsUrl:'ws://127.0.0.1:3001',onebotToken:'test-onebot-token'};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'friend-transfer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const old=path.join(dir,'old'),data=path.join(old,'data'),music=path.join(old,'music');
  fs.mkdirSync(data,{recursive:true});fs.mkdirSync(music);fs.writeFileSync(path.join(music,'sample.wav'),'fixture');
  const configPath=path.join(old,'config.json');fs.writeFileSync(configPath,JSON.stringify({llm:{apiKey:'old-test-key',model:'old-model'},access:{ownerQQ:'10001',adminQQ:['10001'],privateAllow:['10001']},library:{dir:music},qzone:{enabled:true},voice:{token:'old-voice-fixture'}}));
  fs.mkdirSync(path.join(data,'documents'));fs.writeFileSync(path.join(data,'documents','note.docx'),'fixture-document');
  fs.writeFileSync(path.join(data,'persona.md'),'测试人格');
  fs.writeFileSync(path.join(data,'global.json'),JSON.stringify({owner:{name:'旧主人',likes:['旧喜好']},other:'保留'}));
  fs.writeFileSync(path.join(data,'chat.json'),JSON.stringify({owner:'10001',text:'保留原始会话，不改身份'}));
  fs.writeFileSync(path.join(data,'office-deliveries.json'),JSON.stringify([{file:path.join(data,'documents','note.docx'),requester:'10001',status:'sending'}]));
  fs.writeFileSync(path.join(data,'media-log.json'),JSON.stringify([{path:path.join(data,'documents','note.docx'),actorId:'10001'}]));
  return {dir,old,data,configPath,options:{configPath,dataDir:data,sourceRoot:old,outParent:dir}};
}

test('private export includes config, history, media and external music without changing the originals',t=>{
  const f=fixture(t),before=fs.readFileSync(f.configPath),result=exportPrivate(f.options);
  assert.ok(result.files>=7);assert.equal(inspectTransfer(result.folder).config.llm.apiKey,'old-test-key');
  assert.equal(result.manifest.copiedLibrary,true);assert.equal(result.manifest.accountLoginIncluded,false);
  assert.equal(fs.readFileSync(path.join(result.folder,'external/music/sample.wav'),'utf8'),'fixture');
  assert.deepEqual(fs.readFileSync(f.configPath),before);
});

test('transfer corruption and extra files are rejected before installing credentials',t=>{
  const f=fixture(t),r=exportPrivate(f.options),dest=path.join(f.dir,'new');fs.mkdirSync(dest);
  fs.appendFileSync(path.join(r.folder,'data/persona.md'),'tampered');
  assert.throws(()=>installOwner({root:dest,transferFolder:r.folder,settings}),/校验/);
  assert.equal(fs.existsSync(path.join(dest,'config.json')),false);
  const second=exportPrivate(f.options);fs.writeFileSync(path.join(second.folder,'extra.txt'),'extra');
  assert.throws(()=>inspectTransfer(second.folder),/数量/);
});

test('new owner gets permissions, old owner loses admin access, provider settings remain and proactive services stay disabled',()=>{
  const c=makeOwnerConfig(settings,{access:{ownerQQ:'10001',adminQQ:['10001'],privateAllow:['10001'],groupAllow:['30003'],allowAllWhenEmpty:true},voice:{token:'voice-fixture'},qzone:{enabled:true}});
  assert.equal(allowedPrivate('20002',c),true);assert.equal(allowedPrivate('10001',c),false);
  assert.deepEqual(c.access.groupAllow,[]);assert.equal(c.qzone.enabled,false);assert.equal(c.voice.token,'voice-fixture');
  assert.equal(c.chat.agents.enabled,true);assert.equal(c.chat.agents.architecture,'single');
  assert.equal(c.office.pythonPath,'.venv/Scripts/python.exe');assert.equal(c.llm.apiKey,settings.apiKey);
});

test('import preserves conversation ownership and uncertain receipts while remapping file paths and owner display',t=>{
  const f=fixture(t),r=exportPrivate(f.options),dest=path.join(f.dir,'new');fs.mkdirSync(dest);
  installOwner({root:dest,transferFolder:r.folder,settings});
  const d=path.join(dest,'data'),records=JSON.parse(fs.readFileSync(path.join(d,'office-deliveries.json')));
  assert.equal(records[0].file,path.join(d,'documents','note.docx'));assert.equal(records[0].status,'sending');assert.equal(records[0].requester,'10001');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d,'chat.json'))).owner,'10001');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d,'global.json'))).owner.name,'新测试员');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d,'handover-original-global.json'))).owner.name,'旧主人');
  assert.equal(fs.readFileSync(path.join(d,'music/sample.wav'),'utf8'),'fixture');
});

test('existing configuration and runtime data cannot be overwritten by a handover',t=>{
  const f=fixture(t);assert.throws(()=>installOwner({root:f.old,settings}),/已有config|已有配置/);
  const dest=path.join(f.dir,'new');fs.mkdirSync(path.join(dest,'data'),{recursive:true});fs.writeFileSync(path.join(dest,'data','keep.txt'),'keep');
  assert.throws(()=>installOwner({root:dest,settings}),/已有运行数据/);
  assert.equal(fs.readFileSync(path.join(dest,'data','keep.txt'),'utf8'),'keep');
});

test('export cannot recurse into itself if a library is set to its output ancestor',t=>{
  const f=fixture(t);fs.writeFileSync(f.configPath,JSON.stringify({library:{dir:f.dir}}));
  assert.throws(()=>exportPrivate(f.options),/不能位于/);
});

test('invalid settings do not create a config or expose a credential-bearing URL',()=>{
  for(const patch of [{ownerQQ:'机器人'},{baseUrl:'https://user:secret@example.invalid/v1'},{wsUrl:'ws://127.0.0.1:3001?access_token=secret'},{apiKey:'YOUR_KEY'}])assert.throws(()=>makeOwnerConfig({...settings,...patch}));
});

test('importing a corrupt persisted journal leaves a visible incomplete marker and cannot silently retry',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.data,'office-deliveries.json'),'{}');
  const r=exportPrivate(f.options),dest=path.join(f.dir,'new');fs.mkdirSync(dest);
  assert.throws(()=>installOwner({root:dest,transferFolder:r.folder,settings}),/日志格式/);
  assert.equal(fs.existsSync(path.join(dest,'config.json')),false);
  assert.equal(fs.existsSync(path.join(dest,'private-import-incomplete')),true);
  assert.throws(()=>installOwner({root:dest,transferFolder:r.folder,settings}),/未完成/);
});

test('generated handover config starts the real bot and admits only the new owner through simulated OneBot', {timeout:15000}, async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'friend-ingress-'));let bot,logs='';const sent=[],requests=[];
  const api=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;requests.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{content:'新主人你好。'},finish_reason:'stop'}]}));});
  await new Promise(r=>api.listen(0,'127.0.0.1',r));
  const qq=new WebSocketServer({host:'127.0.0.1',port:0});await once(qq,'listening');
  qq.on('connection',ws=>ws.on('message',raw=>{
    const r=JSON.parse(raw);if(r.action==='send_private_msg')sent.push(r.params);
    ws.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:r.action==='get_login_info'?{user_id:99990,nickname:'fixture-bot'}:{message_id:1}}));
    if(r.action==='get_login_info')setTimeout(()=>{if(ws.readyState===1)for(const id of [10001,20002])ws.send(JSON.stringify({post_type:'message',message_type:'private',user_id:id,self_id:99990,message_id:id,sender:{nickname:'fixture'},message:[{type:'text',data:{text:'。'}}]}));},50);
  }));
  const cfg=makeOwnerConfig({...settings,baseUrl:`http://127.0.0.1:${api.address().port}`,wsUrl:`ws://127.0.0.1:${qq.address().port}`});
  cfg.chat.firstDelayMs=[0,0];cfg.chat.splitDelayMs=[0,0];cfg.log.file=false;
  fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify(cfg));
  try{
    bot=spawn(process.execPath,['src/index.js'],{env:{...process.env,QQBOT_CONFIG:path.join(tmp,'config.json'),QQBOT_DATA:path.join(tmp,'data')},stdio:['ignore','pipe','pipe']});bot.stdout.on('data',b=>logs+=b);bot.stderr.on('data',b=>logs+=b);
    const done=()=>sent.some(s=>s.message.some(m=>m.data?.text==='新主人你好。'));
    const end=Date.now()+9000;while(!done()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));
    assert.ok(done(),logs);assert.equal(requests.length,1);assert.ok(sent.every(s=>String(s.user_id)==='20002'));
    assert.equal(requests[0].messages.at(-1).content,'。');assert.equal(requests[0].tools,undefined);
  }finally{
    if(bot&&bot.exitCode===null){bot.kill('SIGTERM');await once(bot,'exit');}
    for(const ws of qq.clients)ws.terminate();await new Promise(r=>qq.close(r));await new Promise(r=>api.close(r));fs.rmSync(tmp,{recursive:true,force:true});
  }
});
