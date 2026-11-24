import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Brain} from '../src/brain.js';
import {WeComSecretary} from '../src/wecom-secretary.js';
const secretary=new WeComSecretary({cfg:{wecom:{botId:'test',secretary:{enabled:true,ownerUserId:'owner'}}},
  dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'report-grounding-')),logger:console});
const chatKey='wecom:test:private:owner';
const ctx={chatKey,recentUserRequests:[]};
function add(msgid,user,text,reply){
  secretary.capture({body:{msgid,msgtype:'text',text:{content:text},...(reply&&{quote:{msgid:reply}})}},
    {id:user,userId:user,group:false,identity:{name:user,userId:user},receivedAt:Date.now()});
}
add('p','顾','内页压平。MH-308 我等签收单才压平。');
add('d','杜','内页压平。MH-308 我负责发单。');
add('other','杜','内页压平。MH-422 我已发单。');
add('similar','顾','内页压平返工。MH-901 已完工。');
let report=secretary.reportContext(ctx,'内页压平，MH-308 等哪个人？');
assert.deepEqual(report.messages.map(m=>m.msgid),['p','d']);
secretary.rememberSources(report.messages.map(m=>m.id));
add('new','杜','MH-308 的签收单交给顾了。');
add('othernew','杜','这一批完工了。','other');
report=secretary.reportContext({...ctx,recentUserRequests:['现在谁在等什么？'],resumeReport:true},'能给我最新进展吗？');
assert.deepEqual(report.messages.map(m=>m.msgid),['p','d','new']);
assert.match(secretary.reportContext(ctx,'内页压平，这一批轮到谁？').clarification,/编号/);
assert.equal(secretary.reportContext({...ctx,chatKey:'wecom:test:private:杜'},'内页压平，MH-308 怎么了？'),null);

const sources=report.messages;
const plan={items:[{kind:'下一步',actorId:sources[0].id,answer:'顾已压平并填写请款单。',
  basis:[{id:sources[0].id,quote:'才压平'},{id:sources[2].id,quote:'签收单交给顾了'}]}]};
async function review(first,second) {
  const fake={chat:async({messages})=>({content:JSON.stringify(messages[0].content.startsWith('独立核查')?second:first)})};
  return Brain.prototype.reviewReport.call({llm:fake},{question:'接下来谁处理？',asOf:new Date().toISOString(),report,evidence:sources});
}
const good=await review(plan,plan);
assert.match(good,/下一步 · 顾/);
assert.match(good,/我等签收单才压平/);
assert.doesNotMatch(good,/请款单|已压平/);
const unexpected=await review(plan,{items:[{kind:'已批准付款',basis:plan.items[0].basis}]});
assert.match(unexpected,/员工原话/);
assert.doesNotMatch(unexpected,/批准付款/);
assert.match(await review(plan,{items:[{kind:'下一步',actorId:'missing',basis:plan.items[0].basis}]}),/还不能确认/);
assert.match(await review(plan,{items:[{kind:'原话',basis:[{id:sources[2].id,quote:'顾已经压平'}]}]}),/还不能确认/);

const assignment={id:'msg-1',sender:'user-1',senderName:'李茗',text:'我带队搬展台。'};
const other={id:'msg-2',sender:'user-2',senderName:'夏容',text:'我把车钥匙交回了。'};
async function verifyActor(personField, rows=[assignment,other], quote=rows[0].text) {
  const draft={items:[{kind:'下一步',...personField,basis:[{id:rows[0].id,quote}]}]};
  return Brain.prototype.reviewReport.call({llm:{chat:async({messages})=>({content:JSON.stringify(
    messages[0].content.startsWith('独立核查')?{ok:true}:draft)})}},
    {question:'接下来谁移展台？',report:{limited:true,links:[],messages:rows},evidence:rows});
}
assert.match(await verifyActor({actorSourceId:assignment.id}),/下一步 · 李茗/);
assert.match(await verifyActor({actorId:assignment.sender}),/下一步 · 李茗/);
assert.match(await verifyActor({actorId:other.sender}),/还不能确认/);
assert.match(await verifyActor({actorSourceId:assignment.sender}),/还不能确认/);
assert.match(await verifyActor({actorId:assignment.sender},[{...assignment,text:'领班说：“我带队搬展台。”'},other]),/还不能确认/);
assert.match(await verifyActor({actorId:assignment.sender},[{...assignment,text:'并非由我带队搬展台。'},other],'由我带队搬展台'),/还不能确认/);

add('phone','顾','北岸话务留有外呼记录，接通无人证实。');
const check=secretary.reportContext(ctx,'北岸叫醒服务可以报客人已经接听吗？');
assert.ok(check.messages.some(m=>m.msgid==='phone'));
assert.equal(secretary.reportContext(ctx,'明天可以报名游泳吗？'),null);

// Search hit 40 unrelated messages. Only the two sources used in the
// delivered report belong to the next question. A new reply arrived overnight.
const prev='昨天下午那两笔费用是怎么回事？';
add('van-request','陈望','请您批借车和搬运费。');
add('van-quote','林霏','我发了车价，还没订。');
for(let i=0;i<40;i++) add('unrelated-'+i,'余星','星桥场地第'+i+'组还在排期。');
const read=secretary.records.slice(-42).map(s=>s.id);
secretary.rememberSources(read);
add('van-update','陈望','车借到了，两笔都撤。我带人搬。','van-request');
const rendered='陈望的消息：“请您批借车和搬运费。”\n林霏的消息：“我发了车价，还没订。”';
for (const metadata of [{previousReportSources:read.slice(0,2)},{previousAnswer:rendered}]) {
  const report=secretary.reportContext({...ctx,recentUserRequests:[prev],previousReport:true,...metadata},'后来两笔如何处理？');
  assert.equal(report.limited,false);
  assert.deepEqual(report.messages.map(m=>m.msgid),['van-request','van-quote','van-update']);
}
assert.equal(secretary.state.latestSources.length,42);

const messages=[assignment,other];
const makePlan=r=>({items:[{kind:'原话',basis:[{id:r.id,quote:r.text}]}]});
let actualBasis;
await Brain.prototype.reviewReport.call({llm:{async chat({messages}){
  return {content:JSON.stringify(makePlan(messages[0].content.startsWith('独立核查')?other:assignment))};
}}},{question:'看看原话。',report:{limited:true,messages,links:[]},evidence:messages,recordBasis:ids=>{actualBasis=ids;}});
assert.deepEqual(actualBasis,[other.id]);
