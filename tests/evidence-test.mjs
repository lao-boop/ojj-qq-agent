import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeRollup} from '../src/wecom-rollup.js';
import {WeComSecretary} from '../src/wecom-secretary.js';

const cases=JSON.parse(fs.readFileSync(new URL('./historical-groups.json',import.meta.url)));
const labels=cases[0].labels;
const reply=obj=>({content:JSON.stringify(obj)});
function linkedTasks(earlier,first,next){
  return [{anchor:first,state:'dependency',basis:first},{anchor:earlier,state:'self',basis:next,after:first}];
}
for(const item of cases){
  let rereads=0;
  const llm={async chat({messages}){
    const p=JSON.parse(messages[1].content);
    if(p.records)return reply({rows:p.records.map(r=>[r.n,item.name,
      r.text.includes('首次登记')?'set':'add',r.text.match(/\d+套/)[0]])});
    if(p.objects){
      assert.deepEqual(p.objects[0].messages,item.messages);
      return reply({groups:[item.original]}); // Saved production error, including its original ref.
    }
    if(p.originals){
      rereads++;
      assert.equal(p.name,item.name);
      const [early,first,next]=item.messages;
      assert.ok(p.originals.some(m=>m.text.includes(first.text)&&m.text.includes(next.text)));
      return reply({tasks:linkedTasks(early.ref,first.ref,next.ref)});
    }
    return reply({countObjects:false,labels:item.labels,unit:'套',focus:item.name});
  }};
  const r=await writeRollup({llm,records:item.records,question:item.question});
  assert.equal(rereads,1,r.text);
  assert.ok(r.text.includes('等内部岗位先办 '+item.amount+' 套'),r.text);
  assert.match(r.text,/办理顺序/);
  assert.ok(r.text.includes(item.messages.at(-1).text));
}
console.log('四个历史错组均触发独立复核，受控复核答复分别将155、119、176、139套归入前置岗位。');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whale-followup-'));
const cfg={wecom:{botId:'local',secretary:{enabled:true,ownerUserId:'boss'}}};
const owner='wecom:local:private:boss',other='wecom:local:private:other';
try{
 const sec=new WeComSecretary({cfg,dataDir:directory,logger:console});
 function add(sid,who,text,parent){
   const body={msgid:sid,msgtype:'text',text:{content:text}};
   if(parent)body.quote={msgid:parent};
   sec.capture({body},{id:who,userId:who,group:false});
   return sec.records.at(-1).id;
 }
 const a=add('a','甲','北库交接【石榴组】入账5套。我做归档。');
 const b=add('b','甲','质检岗先盖验收章，我拿到才装订。','a');
 const c=add('c','乙','北库交接【香樟组】入账2套。门卡是否外借请您定。');
 const q='关于北库交接，按现在分工汇总实际数量，单位为套。分栏：'+labels.join('、')+'。单说石榴组，现在谁先处理？';
 let rereads=0, invalid=false;
 sec.llm={async chat({messages}){
   const p=JSON.parse(messages[1].content);
   if(p.records)return reply({rows:p.records.map(r=>[r.n,r.id===c?'香樟组':'石榴组',r.id===b?'keep':'set',r.id===b?'':r.text.match(/\d+套/)[0]])});
   if(p.objects)return reply({groups:p.objects.map(obj=>obj.name==='石榴组'?{name:obj.name,reread:true}:
     {name:obj.name,tasks:[{anchor:obj.messages[0].ref,basis:obj.messages[0].ref,state:'owner'}]})});
   if(p.originals){
     rereads++; assert.ok(p.originals.some(m=>m.id===b&&m.quotedSource===a));
     const [early,first,next]=p.messages;
     return reply({tasks:linkedTasks(early.ref,first.ref,invalid?'foreign.1':next.ref)});
   }
   return reply({countObjects:false,labels,unit:'套',focus:'石榴组'});
 }};
 const answer=await sec.command(q,owner);
 assert.match(answer,/等内部岗位先办 5 套/);assert.match(answer,/需要老板决定 2 套/);
 assert.equal(rereads,1); assert.ok(sec.state.followupSources.includes(b));assert.ok(!sec.state.followupSources.includes(c));
 const api=sec.wrapTools({specs:[],run(){throw Error('unexpected base tool')}});
 const numericContext={chatKey:owner,requestText:q.replace('关于北库交接，','帮我算一算北库交接。')};
 const summed=await api.run('sum_colleague_reports',{subject:'北库交接'},numericContext);
 assert.equal(summed,answer);assert.ok(numericContext.rollupEvidence.focus.includes(b));
 const countBefore=rereads;
 assert.equal(await api.run('sum_colleague_reports',{subject:'北库交接'},numericContext),answer);
 assert.equal(rereads,countBefore);
 const d=add('d','甲','验收章已盖好，我今天装订。','b');
 const away=add('away','乙','另外一份已作废。','b');
 const context={chatKey:owner,requestText:'那件现在轮到谁？'};
 const result=JSON.parse(await api.run('read_report_followup',{},context));
 assert.equal(result.focused,true);assert.ok(result.messages.some(m=>m.id===d));
 assert.ok(!result.messages.some(m=>m.id===away||m.id===c));
 assert.ok(result.threads.some(t=>t.links.some(link=>link.reply===d&&link.quoted===b)));
 assert.ok(!(await api.specsForChat({chatKey:other})).length);
 assert.match(await api.run('read_report_followup',{},{chatKey:other}),/无权/);
 assert.match(await api.run('sum_colleague_reports',{subject:'北库交接'},context),/数量问题/);
 invalid=true;
 const subset=sec.records.slice(0,3).map(r=>sec.reportMessage(r,2000));
 const fail=await writeRollup({llm:sec.llm,records:subset,question:q});
 assert.match(fail.text,/无法给出完整总数/);assert.deepEqual(fail.sources,[]);
 const restored=new WeComSecretary({cfg,dataDir:directory,logger:console});
 assert.equal(restored.followup().focused,true);
 restored.rememberSources([a,c]);
 assert.equal(restored.followup().focused,false);
 for(let i=0;i<10;i++)add('page'+i,'甲','回复第'+i+'条','b');
 const firstPage=sec.thread(b), secondPage=sec.thread(b,firstPage.nextOffset);
 assert.equal(firstPage.nextOffset,8);
 assert.equal(secondPage.nextOffset,null);
 assert.ok(secondPage.messages.some(m=>m.id===d));
 delete restored.state.followupSources;assert.ok(restored.followup().threads.some(t=>t.anchor===c));
 console.log('新措辞按组调回原文、关联前后动作、越组依据被拒、重启后追问、跨私聊隔离及旧数据读取均通过。');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
