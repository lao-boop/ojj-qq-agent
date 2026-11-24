import assert from 'node:assert/strict';
import {SemanticRelay} from '../src/semantic-relay.js';
const contacts=[{userid:'a',name:'唐乐'},{userid:'b',name:'采购小何'},{userid:'c',name:'设计小何'}];
const replies=[], sent=[];
const api=new SemanticRelay();
function mockAudience(req,body){
  const {clauses}=JSON.parse(req.messages[1].content);
  return {content:JSON.stringify({labels:clauses.map(c=>body.includes(c)?'员工':c.includes(body)?{员工原文:body}:'助手')})};
}
let previousAnswer;
const llm={async chat(request){
  if(request.messages[0].content.startsWith('按执行人拆分'))return mockAudience(request,previousAnswer.items[0].body);
  if(!request.reasoning){assert(replies.length);previousAnswer=replies.shift();}
  return {content:JSON.stringify(previousAnswer)};
}};
const call=(text,answer,key='boss')=>{
  replies.push(answer);
  return api.run(key,{text,users:contacts,groups:[],llm,deliver:async(target,body)=>{sent.push([target.userid,body]);return {ok:true}}});
};
const plan={action:'send',items:[{who:'唐乐',body:'明早确认。'},{who:'小何',body:'不超过5箱，周三回。'}]};
assert.match((await call('告诉唐乐：明早确认。告诉小何：不超过5箱，周三回。',plan)).reply,/哪位/);
assert.equal(sent.length,0);
assert.match((await call('对，就是小何',{action:'unclear'})).reply,/哪位/);
assert.equal(sent.length,0);
await call('设计那边的！原文不改。',{action:'choose',id:'c',body:'原文不改。'});
assert.deepEqual(sent,[['a','明早确认。'],['c','不超过5箱，周三回。']]);
await call('给唐乐说：明早确认。然后通知小何：不超过5箱，周三回。',plan);
await call('先不通知了',{action:'cancel'});
assert.equal(sent.length,2);
await call('项目P87是唐乐在管',{action:'note',focus:{who:'唐乐',ref:'P87'}});
await call('麻烦捎句话给他，提前5天。',{action:'send',items:[{who:'@focus',body:'提前5天。',useFocus:true}]});
assert.deepEqual(sent.at(-1),['a','P87，提前5天。']);
await call('你给他捎句好。',{action:'send',items:[{who:'@focus',body:'好。'}]},'second');
assert.equal(sent.length,3);
await call('给唐乐说：好。给没登记的人说：收到。',{action:'send',items:[{who:'唐乐',body:'好'},{who:'没登记的人',body:'收到'}]});
assert.equal(sent.length,3);
assert.deepEqual(replies,[]);
console.log('semantic relay checks passed');

const reviewer=new SemanticRelay();
const strongSent=[];
async function compare(input,first,second,expectedReviews=1,session='review'){
  let reviews=0;
  const llm={cfg:{model:'primary',intentReviewModel:'strong'},async chat(request){
    if(request.reasoning){reviews++;assert.equal(request.model,'strong');assert.equal(request.directAnswer,false);}
    const answer=request.reasoning?second:first;
    if(answer instanceof Error)throw answer;
    return {content:JSON.stringify(answer)};
  }};
  const reply=await reviewer.run(session,{text:input,users:contacts,groups:[],llm,deliver:async(u,body)=>{
    strongSent.push([u.userid,body]);return {ok:true};
  }});
  assert.equal(reviews,expectedReviews);
  return reply;
}
await compare('给唐乐留个口信：周三核对原件。',{action:'note'}, {action:'send',items:[{who:'唐乐',body:'周三核对原件。'}]});
assert.deepEqual(strongSent,[['a','周三核对原件。']]);
await compare('告诉唐乐哈，周三核对原件。',{action:'ask',question:'确认哪两个人？'}, {action:'send',items:[{who:'唐乐',body:'周三核对原件。'}]});
await compare('帮我写一段给唐乐的口信，只让我过目。',{action:'draft',draft:'初稿'}, {action:'draft',draft:'请核对原件。'});
await compare('先不转达，唐乐是负责人。',{action:'note'}, {action:'note',focus:{who:'唐乐',ref:''}});
await compare('给负责人带句话：保留胸牌。',{action:'ask'}, {action:'send',items:[{who:'@focus',body:'保留胸垫。'}]});
assert.equal(strongSent.length,2);
await compare('给唐乐留个口信：名单晚些交。',new SyntaxError('invalid JSON'),{action:'send',items:[{who:'唐乐',body:'名单晚些交。'}]});
await compare('给唐乐留个口信：再核一次。',{action:'note'},new Error('review unavailable'));
assert.equal(strongSent.length,3);
console.log('intent review checks passed');

const confirmation=await compare('帮我告诉唐乐啊，原件周三到。',
  {action:'send',items:[{who:'唐乐啊',body:'原件周三到。'}]},
  {action:'ask',question:'每位收件人对应哪一段？'});
assert.match(confirmation.reply,/已发给 唐乐/);
assert.deepEqual(strongSent.at(-1),['a','原件周三到。']);

const boundaries=new SemanticRelay();
const proof=[];
async function simulate(text,plan,excerpt){
  const model={async chat(req){if(req.messages[0].content.startsWith('按执行人拆分'))return mockAudience(req,plan.items[0].body);return {content:JSON.stringify(plan)}}};
  return boundaries.run('boundaries',{text,users:contacts,groups:[],llm:model,deliver:async(u,t)=>{proof.push([u.userid,t]);return {ok:true}}});
}
await simulate('排班-405现在归唐乐负责。',{action:'note',focus:{ref:'排班-405',who:'唐乐'}});
await simulate('给他捎信，把单号放前面：水杯只领2盒。',{action:'send',items:[{who:'@focus',body:'水杯只领2盒。',useFocus:true}]},'把单号放前面：水杯只领2盒。');
await simulate('发给他，原话是“编号别漏，把水杯领走。”',{action:'send',items:[{who:'@focus',body:'编号别漏，把水杯领走。',useFocus:true}]},'编号别漏，把水杯领走。');
assert.deepEqual(proof,[['a','排班-405，水杯只领2盒。'],['a','排班-405，编号别漏，把水杯领走。']]);
assert.equal(await simulate('聊聊唐乐手里的展览吧，场次号展览-702。',{action:'other'}),null);
await simulate('跟他讲：展板先别动。',{action:'send',items:[{who:'@focus',body:'展板先别动。',useFocus:true}]},'展板先别动。');
assert.deepEqual(proof.at(-1),['a','展览-702，展板先别动。']);
await simulate('刚和唐乐聊完，他负责移交-612-B。',{action:'note',focus:{who:'唐乐',ref:'-612-B'}});
await simulate('原样传给他：“看下这条，手稿别寄。”',{action:'send',items:[{who:'@focus',useFocus:true,body:'看下这条，手稿别寄。'}]},'看下这条，手稿别寄。');
assert.deepEqual(proof.at(-1),['a','移交-612-B，看下这条，手稿别寄。']);
await simulate('麻烦喊唐乐过目这段，手稿别寄。',{action:'send',items:[{who:'唐乐',body:'过目这段，手稿别寄。'}]});
assert.deepEqual(proof.at(-1),['a','手稿别寄。']);

async function classifiedRelay(items,labels){
  const text='告诉他：明早开箱。请你在消息头标上业务号。员工要核对箱签。少一件就停。';
  const model={async chat(req){
    if(req.messages[0].content.startsWith('按执行人拆分')){
      assert.match(req.messages[0].content,/JSON/i);
      assert.deepEqual(JSON.parse(req.messages[1].content).clauses,['告诉他：','明早开箱。','请你在消息头标上业务号。','员工要核对箱签。','少一件就停。']);
      return {content:JSON.stringify({labels})};
    }
    return {content:JSON.stringify({action:'send',items})};
  }};
  return boundaries.run('boundaries',{text,users:contacts,groups:[],llm:model,deliver:async(u,t)=>{proof.push([u.userid,t]);return {ok:true}}});
}
const discontinuous=[{who:'@focus',useFocus:true,body:'明早开箱。员工要核对箱签。少一件就停。'}];
await classifiedRelay(discontinuous,['助手','员工','助手','员工','员工']);
assert.deepEqual(proof.at(-1),['a','移交-612-B，明早开箱。员工要核对箱签。少一件就停。']);
const count=proof.length;
await classifiedRelay(discontinuous,['助手','员工','助手',{员工原文:'不用核对。'},'员工']);
assert.equal(proof.length,count);
