import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { TaskState } from '../src/task-state.js';

test('full QQ ingress separates interleaved file owners and task controls survive a real process restart', {timeout:25000}, async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'task-ingress-')),data=path.join(tmp,'data'),requests=[],sent=[];
  let bot,socket,logs='',connections=0;
  const state=new TaskState({file:path.join(data,'tasks.json')});
  const task=state.add('group:881',{requester:'61001',goal:'松木架清点',slots:{topic:'松木架清点'},kind:'general',operations:['document.create'],forbiddenOperations:[],exclude:[]});
  fs.writeFileSync(path.join(tmp,'甲方资料.txt'),'甲方专属事实：青石。');fs.writeFileSync(path.join(tmp,'乙方资料.txt'),'乙方专属事实：白帆。');
  const api=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const r=JSON.parse(raw);requests.push(r);
    const intake=r.messages[0].content.includes('第一层多模态');
    const content=intake?JSON.stringify({act:'chat',targetId:'',goal:'只读文件',kind:'general',agents:['conversation'],operations:['chat.reply'],forbiddenOperations:[],slots:{inputRef:'file'},exclude:[],missing:[],clarification:''}):'已阅读你发来的资料。';
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content}}]}));
  });await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const qq=new WebSocketServer({host:'127.0.0.1',port:0});await once(qq,'listening');
  qq.on('connection',ws=>{socket=ws;connections++;ws.on('message',raw=>{
    const r=JSON.parse(raw);if(r.action==='send_group_msg')sent.push(r.params);
    ws.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:r.action==='get_login_info'?{user_id:30001,nickname:'test'}:r.action==='get_group_info'?{group_name:'测试群'}:{message_id:sent.length+1}}));
  });});
  const config={onebot:{wsUrl:`ws://127.0.0.1:${qq.address().port}`},llm:{baseUrl:`http://127.0.0.1:${api.address().port}`,apiKey:'fake',timeoutMs:2000},vision:{enabled:false},access:{groupAllow:['881'],privateAllow:[],allowAllWhenEmpty:false},chat:{agents:{enabled:true},group:{replyOnAt:true,chanceReply:0,minIntervalMs:0},rateLimit:{perChatPerMinute:0},firstDelayMs:[0,0],splitDelayMs:[0,0]},files:{pythonPath:path.resolve('.venv/bin/python')},console:{enabled:false},qzone:{enabled:false},tts:{enabled:false},song:{enabled:false},voice:{enabled:false},library:{enabled:false},image:{enabled:false},asr:{enabled:false,local:{enabled:false}},log:{file:false}};
  fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify(config));
  const start=()=>{bot=spawn(process.execPath,['src/index.js'],{env:{...process.env,QQBOT_DATA:data,QQBOT_CONFIG:path.join(tmp,'config.json')},stdio:['ignore','pipe','pipe']});bot.stdout.on('data',b=>logs+=b);bot.stderr.on('data',b=>logs+=b);};
  const stop=async()=>{if(bot && bot.exitCode===null){bot.kill('SIGTERM');await once(bot,'exit');}};
  const wait=async p=>{const end=Date.now()+7000;while(!p()&&Date.now()<end)await new Promise(r=>setTimeout(r,25));assert.ok(p(),logs);};
  const send=(actor,message)=>socket.send(JSON.stringify({post_type:'message',message_type:'group',group_id:881,user_id:actor,self_id:30001,message_id:Date.now(),sender:{nickname:`用户${actor}`},message}));
  const text=(actor,value)=>send(actor,[{type:'text',data:{text:value}}]);
  const replies=()=>sent.flatMap(m=>m.message).map(s=>s.data?.text||'').join('\n');
  try {
    start();await wait(()=>connections===1);text(61002,`/cancel ${task.id.slice(0,8)}`);await wait(()=>replies().includes('没有找到属于你的'));
    assert.equal(requests.length,0);text(61001,'/tasks');await wait(()=>replies().includes('松木架清点'));assert.equal(requests.length,0);
    for(const [actor,name] of [[61001,'甲方资料.txt'],[61002,'乙方资料.txt']])send(actor,[{type:'at',data:{qq:'30001'}},{type:'text',data:{text:'只读我这份资料并简述，不要生成文件。'}},{type:'file',data:{name,file:path.join(tmp,name)}}]);
    await wait(()=>requests.filter(r=>r.messages[0].content.includes('第一层多模态')).length===2);
    const inputs=requests.filter(r=>r.messages[0].content.includes('第一层多模态')).map(r=>JSON.parse(r.messages[1].content));
    for(const [actor,mine,other] of [['61001','甲方资料','乙方资料'],['61002','乙方资料','甲方资料']]) {
      const input=inputs.find(i=>i.actorId===actor);assert.equal(input.attachments.files.length,1);assert.match(input.attachments.files[0].name,new RegExp(mine));assert.doesNotMatch(input.evidence,new RegExp(other));
    }
    await wait(()=>replies().match(/已阅读/g)?.length===2);
    text(61001,`/cancel ${task.id.slice(0,8)}`);await wait(()=>replies().includes('已取消这项待处理草稿'));
    const before=requests.length;await stop();start();await wait(()=>connections===2);sent.length=0;text(61001,`/task ${task.id.slice(0,8)}`);await wait(()=>replies().includes('已取消'));
    assert.equal(requests.length,before);
  } finally {await stop();for(const s of qq.clients)s.terminate();await new Promise(r=>qq.close(r));await new Promise(r=>api.close(r));fs.rmSync(tmp,{recursive:true,force:true});}
});
