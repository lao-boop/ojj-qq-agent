import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Brain} from '../src/brain.js';
import {DEFAULTS} from '../src/config.js';
import {WeComRuntime} from '../src/wecom-runtime.js';
import {WeComSecretary} from '../src/wecom-secretary.js';

// Each row has a separate archive. The evidence and expected business judgment
// are available only to the test, never to the question-answering code.
const cases = [
  ['客席请示','主桌和侧桌都请您定。',['侧桌我负责安排，主桌还请您选。'],'剩下哪张桌还需要我拍板？','只需选主桌；侧桌由员工安排，尚无完成记录。'],
  ['园区接送','请选车型，也请准许加派一辆。',['车型我按标准配。','增派申请取消，现有车辆就够。'],'接下来还有什么要我签？','车型由员工配，增派已取消，两项都不用老板签。'],
  ['工位布置','临窗工位想请您定。',['座位我自行轮换。','消防通道被占，只将通道旁位置报您选。'],'那交给我的具体是哪一项？','仅通道旁位置重新请示；不能说全部座位又待定。'],
  ['展架移库','要等库务发放行单，再由唐师傅移架。',['库务刚发了单子，架子还在原位。'],'眼下谁先办？','前置已满足，唐师傅先移架，尚未完成，未请老板批准。'],
  ['午餐预订','午餐标准等负责人批。',['素餐改为三份，餐标没改。'],'更新一下我手里的请示。','素餐数量更新，餐标仍等负责人批；无关印章事项不在本案。'],
  ['机房陪同','尚待值守员确认，之后我去接人。',[],'那这件有没有往前走？','本案已读记录无新增，仍等值守员；不能说已确认或老板待批。'],
  ['证件塑封','要请您选亮面还是哑面。',['表面按统一标准办；要不要印服务电话请您定。'],'摊开来讲，我最该过目什么？','选表面已撤回，只等是否印电话。'],
  ['器材双柜','红柜和灰柜都列在移交清单。',['她让我先锁那一个，我没听清指哪个。'],'那她说的究竟是哪一个？','目前不能区分红柜或灰柜，应追问具体柜号，不替员工猜。']
];
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'whale-entry-'));
for (const [i,[topic,original,updates,question]] of cases.entries()) {
  const cfg=structuredClone(DEFAULTS);
  Object.assign(cfg.wecom,{botId:'bench',mode:'open',secretary:{enabled:true,ownerUserId:'boss'}});
  const dataDir=path.join(temp,String(i));
  const logger={info(){},warn(){},error:console.error};
  const secretary=new WeComSecretary({cfg,dataDir,logger});
  const conversations=new Map();
  const memory={
    context(key){const turns=conversations.get(key)||[];return {notes:[],turns:[...turns],previousReport:turns.at(-1)?.reportEvidence};},
    append(key,role,content,_title,{reportEvidence}={}){conversations.set(key,[...(conversations.get(key)||[]),{role,content,reportEvidence}]);},
    async maybeSummarize(){}
  };
  let verified=false,requests=0;
  const brain=new Brain({cfg:cfg.chat,logger,memory,tools:secretary.wrapTools({specs:[]}),
    personaProvider:()=>'',globalContext:()=>'',llm:{async chat({messages}){
      if(messages[0].content.startsWith('判断两句老板私聊')) {
        const pair=JSON.parse(messages[1].content);
        assert.ok(pair.previous.includes(topic));
        assert.equal(pair.current,question);
        return {content:'{"same":true}'};
      }
      if(messages[0].content.startsWith('为老板的连续追问')) return {content:'{"rows":[]}'};
      if(messages[0].content.startsWith('独立核查')) return {content:'{"ok":true}'};
      if(messages[0].content.startsWith('你复核')){
        const input=JSON.parse(messages.at(-1).content);
        if (input.question !== question) {
          assert.ok(input.question.includes(topic));
          return {content:JSON.stringify({items:[{answer:'已收到。',basis:[{id:input.sources[0].id,quote:original}]}]})};
        }
        requests++;
        assert.deepEqual(input.sources.map(e=>e.text),[topic+'。'+original,...updates]);
        assert.ok(input.sources.every(e=>e.sender==='employee'));
        verified=true;
        // Exercise validation/delivery only. This synthetic response earns no semantic score.
        return {content:JSON.stringify({updates:input.endpoints.map(id=>({id,effect:'relevant',reason:'本案进展'})),
          items:[{answer:'查到如下记录。',basis:input.sources.map(e=>({id:e.id,quote:e.text}))}]})};
      }
      if(messages.at(-1).content.endsWith(question)){
        requests++;
        assert.deepEqual(JSON.parse(messages.at(-2).content).messages.map(e=>e.text),[topic+'。'+original,...updates]);
      }
      return {content:'收到。'};
    }}});
  let delivered;
  const sender={async replyText(){},async sendResult(frame,result){delivered=result.bubbles.join('');}};
  const runtime=new WeComRuntime({cfg,brain,memory,sender,dataDir,logger,secretary});
  let seq=0;
  async function send(userid,text,parent){
    const id='p'+(++seq);
    await runtime.handle({headers:{req_id:id},body:{msgid:id,aibotid:'bench',chattype:'single',
      msgtype:'text',from:{userid},text:{content:text},...(parent && {quote:{msgid:parent}})}});
    return id;
  }
  let parent=await send('employee',topic+'。'+original);
  await send('boss','关于'+topic+'，上次怎么说的？');
  const prior=conversations.get('wecom:bench:private:boss').at(-1);
  assert.equal(prior.reportEvidence,true);
  prior.content='已有原话可以核对。';
  for(const text of updates) parent=await send('employee',text,parent);
  await send('other','印章归档。用印申请撤回。');
  await send('boss',question);
  assert.equal(requests,1);
  assert.equal(verified,true);
  assert.ok(delivered.includes(updates.at(-1)||original));
  assert.equal(runtime.stats.errors,0);
  console.log('企微私聊入口原话核对通过',topic);
}
