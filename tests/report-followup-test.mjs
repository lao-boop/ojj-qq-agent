import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Brain} from '../src/brain.js';
import {DEFAULTS} from '../src/config.js';
import {WeComSecretary} from '../src/wecom-secretary.js';

const owner = 'wecom:bench:private:boss';
const cfg = structuredClone(DEFAULTS);
cfg.wecom.botId = 'bench';
cfg.wecom.secretary = {enabled:true,ownerUserId:'boss'};
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'whale-followup-'));
function archive(name) {
  const s = new WeComSecretary({cfg, dataDir:path.join(temp,name), logger:console});
  s.appendEvent = () => {};
  return s;
}
function receive(s, m) {
  const body = {msgid:m.id,msgtype:'text',text:{content:m.text},create_time:Date.parse(m.time)/1000};
  if (m.reply_to) body.quote={msgid:m.reply_to};
  return s.capture({body},{id:m.chat_id,userId:m.sender_id,group:false,
    receivedAt:Date.parse(m.time),identity:{name:m.sender_name,userId:m.sender_id}});
}
async function probe(s, q, turns, review, draft='上轮待办仍有效') {
  let packet,reviewInput;
  const llm = {async chat({messages}) {
    if (messages[0].content.startsWith('独立核查')) return {content:'{"ok":true}'};
    if (messages[0].content.startsWith('只核对同一事项')) return {content:'{}'};
    if (messages[0].content.startsWith('你复核')) {
      reviewInput=JSON.parse(messages.at(-1).content);
      packet ??= {messages:reviewInput.sources.map(s=>({...s,msgid: s.msgid}))};
      return {content:JSON.stringify(review(reviewInput))};
    }
    const input = messages.at(-2);
    assert.equal(input.role,'user');
    packet=JSON.parse(input.content);
    return {content:draft};
  }};
  const memory={context:()=>({notes:[],turns}),append(){},async maybeSummarize(){}};
  const brain=new Brain({cfg:cfg.chat,llm,memory,tools:s.wrapTools({specs:[]}),logger:{info(){}},
    personaProvider:()=>'', globalContext:()=>''});
  const command=await s.command(q.question,owner);
  assert.equal(command,null);
  const result=await brain.respond({chatKey:owner,title:'老板',userText:q.question,
    meta:{scene:'企业微信私聊',message:{userId:'boss',receivedTime:q.asked_at}}});
  return {packet,reviewInput,answer:result.bubbles.join('')};
}
const benchmark=process.argv[2];
if (benchmark) {
  const read = (...parts)=>JSON.parse(fs.readFileSync(path.join(benchmark,...parts)));
  for (const size of ['200','2000','10000']) {
    const ms=read('bank',size,'员工私聊.json');
    const qs=read('bank',size,'只给秘书的题目.json');
    const s=archive(size);
    for (const m of ms) receive(s,m);
    for (const q of qs.filter(q=>q.continue_from)) {
      assert.ok(ms.every(m=>m.time<=q.as_of));
      const prior=read('results',q.continue_from+'.json');
      s.state=structuredClone(prior.state);
      const {packet,reviewInput,answer}=await probe(s,q,prior.memory.turns,()=>({items:[]}),prior.answer);
      const required=read('audit',q.id+'.json').required;
      for (const id of required) {
        const m=ms.find(m=>m.id===id);
        const e=packet.messages.find(e=>s.byId.get(e.id)?.msgid===id);
        assert.ok(e && e.text.includes(m.text) && e.sender===m.sender_id,q.id+' '+id);
        assert.ok(reviewInput.sources.some(r=>r.id===e.id && r.text===e.text));
      }
      assert.match(answer,/还不能确认/);
      console.log(q.id, 'required',required.length,'delivered',packet.messages.length);
    }
  }
}
const scenarios=[
 ['部分撤回',['叉车由我去借，装卸时间仍请您定。']],
 ['全部撤回',['仓位我去谈，通行证也走常规流程，两项都不用您拍了。']],
 ['重新请示',['这两项我自己处理。','刚收到限高通知，只把大车改走西门重新报您定。']],
 ['只改前置',['放行函已到。照旧由阿林先核验，交接还没有开始。']],
 ['无关事项并发',['先走原定路线，夜间窗口仍请您选。']],
 ['没有新进展',[]],
 ['指向有歧义',['两个窗口都有人问。她说“那个别动”，没说是哪一个。']]
];
for (const [i,[name,updates]] of scenarios.entries()) {
  const s=archive('new'+i);
  const originals=['叉车和装卸时间都等负责人定。','仓位和通行证都等负责人批。','原定东门入场，请负责人批两项。','等放行函到了，由阿林核验后再交接。','夜间窗口请负责人选。','请负责人选入库时段。','一号和二号窗口都待确认。'];
  const root={id:'start',sender_id:'u1',sender_name:'施宁',chat_id:'私聊甲',text:'鹭港转运。'+originals[i],time:'2026-09-01T10:00:00+08:00'};
  const anchor=receive(s,root);
  let parent=root.id;
  for (const [j,text] of updates.entries()) {
    const id='r'+j;
    receive(s,{...root,id,reply_to:parent,text,time:'2026-09-02T10:0'+j+':00+08:00'});
    parent=id;
  }
  receive(s,{...root,id:'else',sender_id:'u2',chat_id:'私聊乙',text:'仓库清洗。明早停水，请批准。'});
  s.rememberSources([anchor]);
  const ctx=[{role:'user',content:'关于鹭港转运，昨晚怎么安排？'},{role:'assistant',content:'两项都等负责人。'}];
  const question=['轮到我办的是哪一步？','刚散会，给我更新待办。','到午休为止还要我决定几件？','谁可以先动了？','排个今天的先后顺序。现在谁在等我？','手头这件有进展吗？','她指的是哪一项？'][i];
  const q={question,asked_at:'2026-09-02T12:00:00+08:00'};
  const {packet,answer}=await probe(s,q,ctx,input=>{
    const last=input.sources.at(-1);
    return {updates:input.endpoints.map(id=>({id,effect:'relevant',reason:'本事项最后补充'})),items:[{answer:'核对原话如下。',basis:[{id:last.id,quote:last.text}]}]};
  });
  assert.deepEqual(packet.messages.map(e=>e.text),[root.text,...updates]);
  assert.ok(answer.includes(updates.at(-1)||root.text));
  assert.equal(s.reportContext({chatKey:'wecom:bench:private:u2',recentUserRequests:[ctx[0].content]},question),null);
  const switched=s.reportContext({chatKey:owner,recentUserRequests:[ctx[0].content]},'关于仓库清洗，能批准吗？');
  assert.deepEqual(switched.messages.map(e=>e.msgid),['else']);
  for (const other of ['午饭吃面好吗？']) {
    assert.equal(s.reportContext({chatKey:owner,recentUserRequests:[ctx[0].content]},other),null);
  }
  const invalid=await probe(s,q,ctx,input=>({items:[{answer:'已批。',basis:[{id:input.sources[0].id,quote:'并不存在的签字'}]}]}));
  assert.match(invalid.answer,/还不能确认/);
  console.log('新场景证据与引文检查通过',name);
}
