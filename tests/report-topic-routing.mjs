import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {WeComSecretary} from '../src/wecom-secretary.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'whale-topic-'));
const cfg = {wecom:{botId:'scope',secretary:{enabled:true,ownerUserId:'boss'}}};
const open = () => new WeComSecretary({cfg,dataDir:tmp,logger:console});
const ctx = {chatKey:'wecom:scope:private:boss',recentUserRequests:[]};
let sec = open();
let clock = Date.parse('2026-09-01T08:00:00+08:00');
function add(msgid, who, text) {
  clock += 60000;
  return sec.capture({body:{msgid,msgtype:'text',text:{content:text}}},
    {id:who,userId:who,group:false,receivedAt:clock,identity:{name:who,userId:who}});
}
function after(question, ids) {
  const prev = '[平台记录的发言者与时间] '+JSON.stringify({receivedTime:new Date(clock).toISOString()})+'\n[消息正文]\n'+question;
  return {...ctx,recentUserRequests:[prev],previousReport:true,previousReportSources:ids};
}
const ids = r => r.messages.map(m=>m.msgid);
try {
  // An employee's name, even when used as a heading in actual documents, is not a topic.
  const lamp = add('old','沙嘉','西楼灯罩。请定铝框还是铜框。');
  const prev = after('西楼灯罩报的什么请示？',[lamp]);
  sec.rememberSources([lamp]);
  add('v','纪琢','沙嘉说：我把值班表交回去了。');
  for (let i=0; i<12; i++) add('pass'+i,'程润','印刷车间第'+i+'号通行证已经发出。');
  add('new','沙嘉','纪琢，东库钢柜的木托已经撤单，暂时不用老板定。');
  add('partner','纪琢','木托撤单我也收到了，我这就登记。');
  for (const text of ['沙嘉，东库钢柜木托的请示后来怎么样？','沙嘉说东库钢柜木托撤单了，现在还要我批吗？']) {
    const r=sec.reportContext(prev,text);
    assert.ok(ids(r).includes('new') && ids(r).includes('partner'));
    assert.ok(!ids(r).includes('old'));
    assert.equal(r.previous,'');
    assert.equal(r.limited,true);
    assert.equal(r.links.length,0);
    assert.ok(r.messages.length <= 24);
  }
  const unknown=sec.reportContext(prev,'紫檀票夹现在怎么样？');
  assert.ok(unknown.checkContinuity && !unknown.messages);
  // A bare follow-up can retrieve an unquoted update a day after the question.
  const ask='东库钢柜木托的撤单是什么情况？';
  const anchor=sec.records.find(r=>r.msgid==='new').id;
  const prior=after(ask,[anchor]);
  sec.rememberSources([anchor]);
  clock+=86400000;
  add('late','沙嘉','我更新一下东库钢柜木托的撤单：库房同意了，已撤销。');
  add('other','程润','南墙标线。已给隔壁班留了图。');
  const follow=sec.reportContext(prior,'那现在呢？');
  assert.ok(ids(follow).includes('late'));
  // A later digest must not substitute its own expensive, unrelated focused group.
  const digest=sec.records.at(-1).id;
  sec.rememberSources([digest],[digest]);
  const asked=after('西楼灯罩的原话是什么？',[lamp]);
  const recovered=sec.reportContext(asked,'那现在呢？');
  assert.ok(ids(recovered).includes('old') && !ids(recovered).includes('other'));
  sec = open();
  assert.equal(sec.namedSubject('沙嘉说还有别的安排吗？'),undefined);
  assert.equal(sec.reportContext({...ctx,chatKey:'wecom:scope:private:沙嘉'},ask),null);
  console.log('换题、人名、跨人补充、无链接更新、定时来源替换、重启与权限检查通过');
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
