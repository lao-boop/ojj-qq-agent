import assert from 'node:assert/strict';
import {Brain} from '../src/brain.js';
import {asksShortfall, resolveShortfall} from '../src/wecom-shortfall.js';

const sources = [{id:'a',text:'共十五组，每组两枚，柜里实点十一枚。'}];
async function compute(plan) {
  const llm={chat:async ({messages})=>({content:JSON.stringify(messages[0].content.startsWith('独立审核') ? {ok:true} : plan)})};
  return resolveShortfall(llm,'缺多少枚？','2026-11-23',{},sources);
}
const planNumbers={known:true,unit:'枚',required:[1,2],available:[3],basis:[1]};
assert.match(await compute({...planNumbers,required:[2,1]}),/还缺19枚/);
assert.match(await compute(planNumbers),/还缺19枚/);
assert.match(await compute({...planNumbers,required:[3],available:[1,2]}),/缺口为0枚/);
assert.match(await compute({...planNumbers,unit:'元'}),/还缺19枚/);
for (const bad of [{available:[]},{required:[5]},{basis:[2]}])
  assert.match(await compute({...planNumbers,...bad}),/未核实/);
assert.equal(asksShortfall('现货还缺多少套？'),true);
assert.equal(asksShortfall('银柳展演纸样还需要补几套才够？'),true);
assert.equal(asksShortfall('还要补领几枚？'),true);
assert.equal(asksShortfall('现在还缺谁的确认？'),false);
assert.equal(asksShortfall('上月差旅费多少？'),false);
assert.equal(asksShortfall('缆圈再添几圈才够？'),true);
assert.equal(asksShortfall('现有的够不够？'),true);

// A comparison can be requested without any of the fast-path wording.
const rephrase='这批能覆盖清单里的用量吗？';
assert.equal(asksShortfall(rephrase),false);
for (const [limited, escalateAt] of [[true,'draft'],[true,'audit'],[false,'draft'],[false,'audit']]) {
  const lines=[{id:'q1',sender:'盘点员',text:'合计要九张，柜里还剩四张。'},
    {id:'q2',sender:'库管',text:'隔壁的另算。'}];
  const steps=[];
  const llm={async chat({messages}) {
    const sys=messages[0].content;
    const quote={items:[{kind:'原话',basis:[{id:'q1',quote:lines[0].text}]}]};
    if (sys.startsWith('你是企业微信内部汇报秘书')) return {content:JSON.stringify(escalateAt==='draft'
      ? {operation:'shortfall'} : {claims:[{text:'清单列了九张。',proof:[{n:1,quote:'合计要九张'}]}]})};
    if (sys.startsWith('逐句核对')) return {content:'{"operation":"shortfall"}'};
    if (sys.startsWith('你复核')) return {content:JSON.stringify(escalateAt==='draft'?{operation:'shortfall'}:quote)};
    if (sys.startsWith('独立核查')) return {content:'{"operation":"shortfall"}'};
    if (sys.startsWith('你给老板核算')) {steps.push('select');return {content:'{"known":true,"unit":"张","required":[1],"available":[2],"basis":[1]}'};}
    if (sys.startsWith('独立审核')) {steps.push('audit');return {content:'{"ok":true}'};}
    throw Error('unexpected model call');
  }};
  const result=await Brain.prototype.reviewReport.call({llm},{question:rephrase,evidence:lines,
    report:{subject:'清单',limited,links:[],messages:lines}});
  assert.match(result,/还缺5张/);
  assert.deepEqual(steps,['select','audit']);
}
const nonNumeric=await resolveShortfall({chat:async()=>({content:'{"applicable":false}'})},'资格够不够？','',{},sources);
assert.equal(nonNumeric,null);
const rejected=await resolveShortfall({chat:async({messages})=>({content:messages[0].content.startsWith('独立审核')
  ? '{"ok":false,"issue":"两边数量均可核实"}' : '{"known":false,"basis":[1]}'})},'还差几枚？','',{},sources);
assert.doesNotMatch(rejected,/的消息/);

const message={id:'r',text:'旧房停电已核实。我得等平台固定后才上去检修。',senderName:'唐卓',sender:'e',receivedAt:'2026-11-18'};
const basis=[{id:message.id,quote:message.text}];
const plan={items:[{kind:'仍在等待',basis},{kind:'可以开始',actorId:'r',basis}]};
const report={limited:true,links:[],messages:[message]};
const review=(question,evidence,draft)=>Brain.prototype.reviewReport.call({
  llm:{chat:async()=>({content:JSON.stringify(draft)})}
},{question,evidence,report});
const answer=await review('现在怎么安排？',[message],plan);
assert.match(answer,/等平台固定后才上去检修/);
assert.doesNotMatch(answer,/已具备开始条件|可以开始/);
const unavailable=await review('还缺多少枚？',sources,{items:[{kind:'原话',basis:[{id:'a',quote:sources[0].text}]}]});
assert.doesNotMatch(unavailable,/员工原话：/);

const ready={...message,text:'巡检签齐了，我可以开声，试听还没开始。'};
const readyBasis=[{id:ready.id,quote:ready.text}];
const inverse=await review('可以开声了吗？',[ready],{items:[{kind:'不能开始',basis:readyBasis},{kind:'不能确认',basis:readyBasis}]});
assert.match(inverse,/可以开声，试听还没开始/);
assert.doesNotMatch(inverse,/条件尚未满足|依据同上/);
assert.equal(asksShortfall('围巾补领签收单上实收多少？'),false);
