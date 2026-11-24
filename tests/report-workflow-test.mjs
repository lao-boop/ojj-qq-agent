import assert from 'node:assert/strict';
import {resolveWorkflow} from '../src/wecom-workflow.js';

const records = [
  {name:'秦念', sender:'e1', time:'2026-10-01', text:'我核数，再把数量给打包岗。'},
  {name:'何言', sender:'e2', time:'2026-10-01', text:'打包岗我来，收到数量再分袋。'},
  {name:'秦念', sender:'e1', time:'2026-10-02', text:'数量刚给打包岗，还没回报分袋完成。'}
];
const report = {subject:'笔芯', previous:'昨天谁先核数？'};
const proof = [{n:2, quote:'收到数量再分袋'}, {n:3, quote:'数量刚给打包岗'}];
const good = {claims:[{text:'数量已交，现在轮到何言分袋，未见分袋完成的回报。', proof}]};
async function run(outputs, options = report) {
  let calls=0;
  const llm={chat:async ({messages}) => {
    assert.ok(calls<outputs.length);
    assert.match(messages[0].content,/json/i);
    return {content:JSON.stringify(outputs[calls++])};
  }};
  const text = await resolveWorkflow(llm, '现在轮到哪一位？', '2026-10-02', options, records);
  assert.equal(calls,outputs.length);
  return text;
}
assert.match(await run([good,{ok:true}]), /现在轮到何言分袋/);
const invented={claims:[{text:'何言分袋写作。', proof}]};
assert.doesNotMatch(await run([invented,good,{ok:true}]), /写作/);
assert.equal(await run([invented,invented]),null);
assert.equal(await run([good,{ok:false},good,{ok:false}]),null);
for (const defect of [
  {text:'秦念分袋。',proof:[proof[0]]},
  {text:'何言分袋。',proof:[{n:2,quote:'我分袋写作'}]},
  {text:'何言分袋。',proof:[{n:8,quote:'分袋'}]}
]) {
  assert.equal(await run([{claims:[defect]},{claims:[defect]}]),null);
}
assert.equal(await run([],{...report,limited:true}),null);

const fictitiousDuty={claims:[{text:'老板还要签分袋单。',proof}]};
assert.equal(await run([fictitiousDuty,fictitiousDuty]),null);
const truncated = [];
const recovered = await resolveWorkflow({chat:async opts=>{
  truncated.push(opts.thinking);
  return {content:truncated.length === 1 ? '' : JSON.stringify(truncated.length === 2 ? good : {ok:true})};
}}, '轮到谁？','2026-10-02',report,records);
assert.match(recovered,/何言分袋/);
assert.deepEqual(truncated,['enabled','disabled','disabled']);
const signed = [
  {sender:'甲',name:'林蕙',time:'2026-10-02',text:'稿子校完交主编签。'},
  {sender:'乙',name:'邱瑾',time:'2026-10-02',text:'我是主编，只签校完的稿。'}
];
const sign = {claims:[{text:'林蕙校完，主编邱瑾签字。',proof:[
  {n:1,quote:'稿子校完交主编签。'},{n:2,quote:'我是主编，只签校完的稿。'}]}]};
const judge={chat:async({messages})=>({content:JSON.stringify(messages[0].content.startsWith('逐句')?{ok:true}:sign)})};
assert.match(await resolveWorkflow(judge,'谁签字？','2026-10-02',report,signed),/邱瑾签字/);
const fakeStatus={claims:[{text:'分袋栏还没写好。',proof}]};
assert.equal(await run([fakeStatus,fakeStatus]),null);
