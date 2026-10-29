import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

test('real QQ entry routes a period with historical audio through one tool-free conversation call', {timeout:15000}, async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'casual-ingress-')),data=path.join(tmp,'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data,'media-log.json'),JSON.stringify([{at:Date.now(),chatKey:'private:10001',actorId:'10001',direction:'in',kind:'audio',title:'旧音频',name:'old.wav'}]));
  const requests=[],sent=[];let bot,logs='';
  const api=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
    // Deliberately never return task JSON: punctuation must not need it.
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'我在呢。'}}]}));
  });await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const qq=new WebSocketServer({host:'127.0.0.1',port:0});await once(qq,'listening');
  qq.on('connection',ws=>ws.on('message',raw=>{
    const r=JSON.parse(raw);if(r.action==='send_private_msg')sent.push(r.params);
    ws.send(JSON.stringify({status:'ok',retcode:0,echo:r.echo,data:r.action==='get_login_info'?{user_id:30001,nickname:'test'}:{message_id:sent.length+1}}));
    if(r.action==='get_login_info')setTimeout(()=>{if(ws.readyState===1)ws.send(JSON.stringify({post_type:'message',message_type:'private',user_id:10001,self_id:30001,message_id:55,sender:{nickname:'测试用户'},message:[{type:'text',data:{text:'。'}}]}));},50);
  }));
  const config={onebot:{wsUrl:`ws://127.0.0.1:${qq.address().port}`},llm:{baseUrl:`http://127.0.0.1:${api.address().port}`,apiKey:'fake',timeoutMs:2000},access:{privateAllow:['10001']},chat:{agents:{enabled:true},firstDelayMs:[0,0],splitDelayMs:[0,0]},console:{enabled:false},log:{file:false},tts:{enabled:false},song:{enabled:false},voice:{enabled:false},library:{enabled:false},image:{enabled:false},qzone:{enabled:false},asr:{enabled:false,local:{enabled:false}}};
  fs.writeFileSync(path.join(tmp,'config.json'),JSON.stringify(config));
  try {
    bot=spawn(process.execPath,['src/index.js'],{env:{...process.env,QQBOT_DATA:data,QQBOT_CONFIG:path.join(tmp,'config.json')},stdio:['ignore','pipe','pipe']});
    bot.stdout.on('data',b=>logs+=b);bot.stderr.on('data',b=>logs+=b);
    const replied=()=>sent.flatMap(m=>m.message).some(s=>s.data?.text==='我在呢。');
    const deadline=Date.now()+9000;while(!replied()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    assert.ok(replied(),logs);assert.equal(requests.length,1);
    assert.equal(requests[0].response_format,undefined);assert.equal(requests[0].tools,undefined);
    assert.equal(requests[0].messages.at(-1).content,'。');
    assert.ok(requests[0].messages.some(m=>m.content.includes('最近的文件往来')&&m.content.includes('旧音频')));
    assert.doesNotMatch(logs,/意图输出校验未通过/);
  } finally {
    if(bot&&bot.exitCode===null){bot.kill('SIGTERM');await once(bot,'exit');}
    for(const ws of qq.clients)ws.terminate();await new Promise(r=>qq.close(r));await new Promise(r=>api.close(r));
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
