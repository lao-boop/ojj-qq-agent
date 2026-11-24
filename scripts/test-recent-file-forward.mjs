import assert from 'node:assert/strict';
import {forwardRecentFile} from '../src/recent-file-forward.js';
const file={type:'file',chatid:'p',name:'清单.txt',path:'new-content',at:Date.now(),position:2};
const deliveries=[];
async function run(text,decision,position=2){
  return forwardRecentFile({text,file:{...file,position},chatid:'p',users:[{name:'小陈',userid:'c'}],groups:{},send:async job=>{deliveries.push(job);return {ok:true}},llm:{async chat(req){
    const context=JSON.parse(req.messages[1].content);
    assert.equal(context.latestUploadPosition,position);
    return {content:JSON.stringify(decision)};
  }}});
}
assert.match((await run('帮我把第二份带到小陈那儿')).reply,/已发给/);
assert.equal(deliveries[0].media.path,'new-content');
assert.equal(deliveries[0].text,undefined);
assert.equal(await run('告诉小陈，明早验货。',{action:'message',body:'明早验货。'}),null);
assert.match((await run('第二份带到小陈那里',{action:'forward',name:'小陈',ordinal:2},3)).reply,/不是当前/);
assert.doesNotMatch((await run('我新补的那个，劳烦拿到小陈那儿',{action:'message',body:'那儿'})).reply,/已发给/);
assert.match((await run('先别传小陈，晚点再定。',{action:'hold'})).reply,/未发送/);
assert.equal(deliveries.length,1);
