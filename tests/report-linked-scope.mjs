import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WeComSecretary} from '../src/wecom-secretary.js';

const sec = new WeComSecretary({
  cfg:{wecom:{botId:'bench',secretary:{enabled:true,ownerUserId:'owner'}}},
  dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'linked-report-')),logger:console,
});
function add(msgid,sender,text,parent) {
  return sec.capture({body:{msgid,msgtype:'text',text:{content:text},...(parent && {quote:{msgid:parent}})}},
    {id:sender,userId:sender,group:false,receivedAt:Date.now()});
}
const ctx = {chatKey:'wecom:bench:private:owner',recentUserRequests:[]};
const prior=add('start','乔','雁浦馆票夹复印。原拟由库管签字。');
add('other','谷','金垣馆票夹复印。原拟由库管签字。');
add('u1','谷','库管请假，现在换值班员签字。','other');
add('u2','乔','库管请假，现在换值班员签字。','start');
sec.rememberSources([prior]);
const follow = {...ctx,previousReport:true,previousReportSources:[prior],recentUserRequests:['关于雁浦馆票夹复印，谁来签字？']};
const route=sec.reportContext(follow,'现在换谁签字？');
assert.ok(route.checkContinuity || route.messages.every(m=>m.sender==='乔'));
const resumed=sec.reportContext({...follow,resumeReport:true},'现在换谁签字？');
assert.deepEqual(resumed.messages.map(m=>m.msgid),['start','u2']);
add('u3','乔','金垣馆票夹复印改为补送纸样。','start');
const selected=sec.reportContext(ctx,'雁浦馆票夹复印的两种做法，请老板决定的是哪种？');
assert.deepEqual(selected.messages.map(m=>m.msgid),['start','u2']);

for (const [prefix,matter] of [['white','白榆库原版借阅'],['red','红楠库原版借阅']]) {
  add(prefix,'馆员',matter+'，保管人允许印样出库，底片只能库内看。');
  add(prefix+'-signed','馆员','借阅人签收了全部印样。',prefix);
}
for (const [prefix,matter] of [['white','白榆库原版借阅'],['red','红楠库原版借阅']]) {
  assert.deepEqual(sec.exactReport(matter).messages.map(r=>r.msgid),[prefix,prefix+'-signed']);
}

const topic='秋浦库十月工件返修';
const north='北'+topic;
for (const [key,heading] of [['base',topic],['north',north]]) {
  add(key+'1','钳工',heading+'，初报十五件。');
  add(key+'2','统计员',heading+'，初报有误。');
  add(key+'3','统计员','最终实数只有十二件。',key+'2');
}
const initial=sec.reportContext(ctx,topic+'，最终多少件？');
assert.equal(initial.exactMatter,topic);
assert.deepEqual(initial.messages.map(r=>r.msgid),['base1','base2','base3']);
const delivered={...ctx,previousReport:true,previousReportMatter:topic,previousReportSources:[initial.messages[2].id],recentUserRequests:[topic+'，最终多少件？']};
assert.ok(sec.reportContext(delivered,'初报还能用吗？').checkContinuity);
assert.deepEqual(sec.reportContext({...delivered,resumeReport:true},'初报还能用吗？').messages.map(r=>r.msgid),['base1','base2','base3']);
assert.equal(sec.reportContext(delivered,north+'，最终多少件？').exactMatter,north);
const actorQuestion='转发表格的人有审批权吗？';
assert.ok(sec.reportContext(delivered,actorQuestion).scopeClues.some(m=>m.msgid==='base1'));
assert.equal(sec.reportContext(delivered,'转发给审批人。'),null);
