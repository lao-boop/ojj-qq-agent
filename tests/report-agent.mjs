import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-investigation-'));
process.env.QQBOT_DATA=dir;
const {DEFAULTS}=await import('../src/config.js');
const {createWecomApp}=await import('../src/wecom-main.js');
const cfg=structuredClone(DEFAULTS);
Object.assign(cfg.wecom,{botId:'test',mode:'open',secretary:{enabled:true,ownerUserId:'boss'}});
cfg.log.file=false;
const app=createWecomApp({cfg});
const scope='竹浦站蓝鹳批的水表抄读';
const question=scope+'，换表以前，从零点到午间实耗多少吨？';
function capture(id,who,text,parent) {
  const body={msgid:id,msgtype:'text',text:{content:text},...(parent&&{quote:{msgid:parent}})};
  return app.secretary.capture({body},{id:who,userId:who,group:false,receivedAt:Date.now(),identity:{userId:who,name:who}});
}
capture('a','徐简',scope+'，零点底数是365吨。');
capture('b','叶舟',scope+'，午间录入累计读数467吨。');
capture('c','叶舟','录入笔误，多记了12吨，照片核准为455吨。','b');
capture('d','吴非','西站红批的水表抄读，午间读数455吨。');
const ids=Object.fromEntries(app.secretary.records.map(r=>[r.msgid,r.id]));
const owner='wecom:test:private:boss';
assert.equal(app.brain.tools.canInvestigate({chatKey:'wecom:test:private:叶舟'}),false);
assert.equal(await app.brain.tools.investigate({chatKey:'wecom:test:private:叶舟'},question,{}),null);
const agentSteps=[],verified=[];
let received;
app.sender.sendResult=async(_frame,result)=>{assert.equal(received,undefined);received=result};
app.sender.replyText=async()=>{};
const identity=userId=>({userId,name:userId});
app.runtime.contacts={peek:identity,resolve:async userId=>identity(userId)};
const arithmetic=(end,quote)=>({action:'answer',claims:[{text:'从零点到午间实耗{结果}。',
  proof:[{id:end,quote},{id:ids.a,quote:'零点底数是365吨'}],
  calculation:{op:'subtract',unit:'吨',operands:[{id:end,value:'455'},{id:ids.a,value:'365'}]}}]});
const steps=[
  {action:'delegate',task:'找到午间复核记录',ids:[ids.b]},
  {action:'thread',id:ids.b},
  {action:'handoff',ids:['不存在的编号']},
  {action:'search',query:'西站红批的水表抄读'},
  arithmetic(ids.d,'午间读数455吨'),
  {action:'thread',id:ids.b},
  arithmetic(ids.c,'照片核准为455吨'),
  {ok:true}
];
app.brain.llm.chat=async ({messages})=>{
  const system=messages[0].content;
  const role=system.startsWith('你是老板私聊的主调查')?'main':system.startsWith('你是只读记忆')?'worker':system.startsWith('你只审核本次')?'audit':'unexpected';
  agentSteps.push(role);
  const input=JSON.parse(messages[1].content);
  assert.equal(input.question,question);
  if (agentSteps.length===4) assert.match(input.feedback.unresolved,/未读编号/);
  if (agentSteps.length===6) assert.match(input.feedback,/不属于/);
  if (role==='audit') verified.push(input.delivery);
  const step=steps.shift();
  assert.ok(step);
  return {content:JSON.stringify(step)};
};
await app.runtime.handle({headers:{req_id:'q1'},body:{msgid:'q1',aibotid:'test',chattype:'single',msgtype:'text',
  from:{userid:'boss'},text:{content:question}}});
assert.deepEqual(agentSteps,['main','worker','worker','main','main','main','main','audit']);
assert.equal(steps.length,0);
assert.match(received.bubbles.join(''),/实耗90吨/);
assert.doesNotMatch(received.bubbles.join(''),/西站红批/);
assert.deepEqual(new Set(received.calculationSources),new Set([ids.c,ids.a]));
assert.deepEqual(new Set(received.reportSources),new Set([ids.c,ids.a]));
assert.equal(verified.length,1);

// A valid handoff returns only selected IDs to the main reader, even when
// the worker read additional neighbors under its private lookup plan.
const initial=app.secretary.evidence(app.secretary.byId.get(ids.a));
let stage=0;
app.brain.llm.chat=async ({messages})=>{
  const input=JSON.parse(messages[1].content);
  const steps=[{action:'delegate',ids:[],task:'定位更正'},
    {action:'search',query:scope},{action:'thread',id:ids.b},
    {action:'handoff',ids:[ids.c]}, {action:'thread',id:ids.c},arithmetic(ids.c,'照片核准为455吨'),{ok:true}];
  if (stage===4) assert.deepEqual(new Set(input.sources.map(s=>s.id)),new Set([ids.a,ids.c]));
  return {content:JSON.stringify(steps[stage++])};
};
const result=await app.brain.tools.investigate({chatKey:owner,evidence:[initial]},question,{messages:[initial]});
assert.equal(stage,7);
assert.match(result.body,/实耗90吨/);
console.log('主调查、有效和无效委托、补查、串批拒收、可追溯核算、老板私聊首答通过');

const selected=app.secretary.records.filter(r=>r.msgid!=='d').map(r=>app.secretary.evidence(r));
const ctx={chatKey:owner,evidence:selected};
const report={messages:selected,exactMatter:scope};
let calls=0;
app.brain.llm.chat=async ({messages})=>{
  const payload=JSON.parse(messages[1].content);
  calls++;
  if (calls===2) return {content:JSON.stringify({ok:false,issue:'请复查是否用了更正后读数'})};
  if (calls===3) {
    assert.match(payload.feedback,/更正后/);
    return {content:JSON.stringify({action:'thread',id:ids.c})};
  }
  return {content:JSON.stringify(calls===5?{ok:true}:arithmetic(ids.c,'照片核准为455吨'))};
};
assert.match((await app.brain.tools.investigate(ctx,question,report)).body,/90吨/);
assert.equal(calls,5);
assert.ok(ctx.investigationTrace.some(s=>s.role==='review' && s.action==='recheck'));

calls=0;
app.brain.llm.chat=async ()=>{
  calls++;
  const plan=arithmetic(ids.c,'照片核准为455吨');
  plan.claims[0].calculation.unit='箱';
  return {content:JSON.stringify(plan)};
};
const invalid=await app.brain.tools.investigate(ctx,question,report);
assert.equal(calls,4);
assert.equal(invalid,null);
assert.ok(ctx.investigationTrace.some(s=>s.role==='recovery' && s.action==='routine'));

app.brain.llm.chat=async ()=>{
  app.secretary.generation++;
  return {content:JSON.stringify({action:'routine'})};
};
const expired=await app.brain.tools.investigate(ctx,question,report);
assert.deepEqual(expired.ids,[]);
assert.match(expired.body,/权限已变更/);

for (const role of ['main','memory','review']) {
  const attempted=[];
  const local={chatKey:owner,evidence:selected};
  app.brain.llm.chat=async ({messages,responseFormat})=>{
    assert.equal(responseFormat.type,'json_object');
    assert.match(messages[0].content,/json/i);
    const current=messages[0].content.startsWith('你只审核')?'review':messages[0].content.startsWith('你是只读')?'memory':'main';
    attempted.push(current);
    if (current===role) throw Object.assign(Error('invalid request'),{status:400});
    return {content:JSON.stringify(role==='memory'?{action:'delegate',task:'查原话',ids:[]}:arithmetic(ids.c,'照片核准为455吨'))};
  };
  const result=await app.brain.tools.investigate(local,question,report);
  assert.equal(attempted.filter(r=>r===role).length,1);
  assert.match(result.body,/HTTP 400/);
  assert.ok(local.investigationTrace.some(s=>s.role===role && s.action==='gateway_error'));
}

// The selected root has two generations of platform replies; the signed
// decision is absent from the first payload and must be read before citation.
capture('root','程杉','杉砚楼值班，最终分工请沿这张交接凭条核对。');
capture('middle','程杉','换岗申请已到。','root');
capture('leaf','程杉','正式确认辛铭值班。','middle');
capture('foreignRoot','程杉','东楼值班，最终人员另行确定。');
capture('foreignLeaf','程杉','正式确认郜桐值班。','foreignRoot');
const msg=id=>app.secretary.records.find(r=>r.msgid===id);
const seeds=['root','middle'].map(id=>app.secretary.evidence(msg(id)));
let turn=0;
app.brain.llm.chat=async ({messages})=>{
  const input=JSON.parse(messages[1].content);
  turn++;
  if (turn===1) return {content:JSON.stringify({action:'thread',id:msg('root').id})};
  if (turn===2) {
    assert.ok(input.sources.some(r=>r.id===msg('leaf').id));
    assert.ok(!input.sources.some(r=>r.id===msg('foreignLeaf').id));
    return {content:JSON.stringify({action:'answer',claims:[{text:'辛铭值班。',proof:[{id:msg('leaf').id,quote:'正式确认辛铭值班。'}]}]})};
  }
  return {content:'{"ok":true}'};
};
const deep=await app.brain.tools.investigate({chatKey:owner,evidence:seeds},'杉砚楼值班，最后由谁值班？',{messages:seeds});
assert.match(deep.body,/辛铭值班/);

const badge='燕井院工牌补领';
capture('badge-listed','朱青',badge+'，有25份有效申领。');
capture('badge-issued','平声',badge+'，已发8张工牌。');
capture('badge-rule','朱青','申领人一人一张。','badge-listed');
const badgeRows=['badge-listed','badge-issued','badge-rule'].map(key=>app.secretary.evidence(msg(key)));
const [listed,issued,rule]=badgeRows.map(r=>r.id);
const badgeClaim={
  text:'仍需{result} 张工牌。',
  proof:[{id:listed,quote:'有25份有效申领。'},{id:issued,quote:'已发8张工牌。'},{id:rule,quote:'申领人一人一张。'}],
  calculation:{op:'subtract',unit:'张',conversion:{id:rule,quote:'申领人一人一张。'},operands:[{id:listed,value:25},{id:issued,value:8}]}
};
const investigateBadge=()=>app.brain.tools.investigate({chatKey:owner,evidence:badgeRows},badge+'，还差多少张？',{messages:badgeRows,exactMatter:badge});
app.brain.llm.chat=async({messages})=>({content:JSON.stringify(messages[0].content.startsWith('你只审核') ? {ok:true} : {action:'answer',claims:[badgeClaim]})});
const badges=await investigateBadge();
assert.match(badges.body,/仍需17张工牌/);
assert.deepEqual(new Set(badges.calculated),new Set([listed,issued,rule]));
badgeClaim.calculation.conversion.quote='申领人一人一套。';
assert.equal(await investigateBadge(),null);

// Ledgers with both arrivals and departures require an independent direction
// for every selected amount. Do not reveal the proposed signs to that reader.
const float='朝溪馆周转金';
capture('float-open','董亦',float+'，开账时有200元。');
capture('float-pay','乔希',float+'，为快递付出40元。');
capture('float-refund','乔希','快递因晚到退给我们8元。','float-pay');
const ledgerRows=['float-open','float-pay','float-refund'].map(key=>app.secretary.evidence(msg(key)));
const proof=ledgerRows.map(({id,text})=>({id,quote:text}));
const amounts=ledgerRows.map(({id},i)=>({id,value:[200,40,8][i]}));
const ledgerPlan=calc=>({action:'answer',claims:[{text:'当前余额为{结果}。',proof,calculation:calc}]});
let ledgerTurn=0;
app.brain.llm.chat=async({messages})=>{
  ledgerTurn++;
  if ([2,4].includes(ledgerTurn)) {
    const payload=JSON.parse(messages[1].content);
    assert.equal(payload.delivery,undefined);
    assert.deepEqual(payload.quantities[0].items,amounts);
    return {content:'{"ok":true,"effects":[["+","-","+"]]}'};
  }
  if (ledgerTurn===1) return {content:JSON.stringify(ledgerPlan({op:'subtract',unit:'元',operands:amounts}))};
  if (ledgerTurn===3) {
    assert.match(messages[1].content,/增减方向不符/);
    const operands=amounts.map((o,i)=>({...o,effect:i===1?'-':'+'}));
    return {content:JSON.stringify(ledgerPlan({op:'balance',unit:'元',operands}))};
  }
  return {content:'{"ok":true}'};
};
const ledger=await app.brain.tools.investigate({chatKey:owner,evidence:ledgerRows},float+'，目前还剩多少钱？',{messages:ledgerRows,exactMatter:float});
assert.match(ledger.body,/当前余额为168元/);
assert.equal(ledgerTurn,5);

const timing='月廊交接';
capture('clock','胡文',timing+'，原定11点出发。');
capture('delay','姚芳',timing+'，已批准往后推3小时。');
const timingRows=['clock','delay'].map(key=>app.secretary.evidence(msg(key)));
const timingClaim={text:'改在{结果}出发。',proof:timingRows.map(({id,text})=>({id,quote:text})),
  calculation:{op:'shift',unit:'点',operands:timingRows.map(({id},i)=>({id,value:i?3:11}))}};
app.brain.llm.chat=async({messages})=>({content:JSON.stringify(messages[0].content.startsWith('你只审核') ? {ok:true} : {action:'answer',claims:[timingClaim]})});
const timed=()=>app.brain.tools.investigate({chatKey:owner,evidence:timingRows},timing+'，改在几点出发？',{messages:timingRows,exactMatter:timing});
assert.match((await timed()).body,/改在14点出发/);
timingClaim.calculation.operands[1].unit='点';
assert.equal(await timed(),null);

let missingCalcTurns=0;
app.brain.llm.chat=async({messages})=>{
  const input=JSON.parse(messages[1].content);
  if (++missingCalcTurns===1) return {content:JSON.stringify({action:'answer',claims:[{text:'{result}',proof:timingClaim.proof}]})};
  if (missingCalcTurns===2) {
    assert.match(input.feedback,/calculation/);
    delete timingClaim.calculation.operands[1].unit;
    return {content:JSON.stringify({action:'answer',claims:[timingClaim]})};
  }
  return {content:'{"ok":true}'};
};
assert.match((await timed()).body,/改在14点出发/);
assert.equal(missingCalcTurns,3);
