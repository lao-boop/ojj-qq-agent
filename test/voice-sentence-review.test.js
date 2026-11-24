import test from 'node:test';
import assert from 'node:assert/strict';
import {applySentenceReview,reviewSentence,weighSentenceSuggestion,reviewRelations,relationClueMatches} from '../src/voice-sentence-review.js';

test('声学一致时独立复核关系，要求真实上下文线索',async()=>{
  const text='木箱靠铆丁固定',primary=Array(5).fill(text);
  const suggestion={heard:'铆丁',candidate:'铆钉',kind:'term',clue:'木箱、固定'};
  let calls=0;
  const llm={chat:async req=>{
    calls++;
    if(calls===2)assert.deepEqual(JSON.parse(req.messages[1].content),{转写:text});
    if(calls===3){
      assert.ok(!req.messages[1].content.includes('铆钉'));
      assert.ok(req.messages[1].content.includes('【空缺】'));
      return {content:JSON.stringify({word:'铆钉',clue:'固定',reason:'固定件'})};
    }
    return {content:JSON.stringify({issue:calls===1?null:suggestion})};
  }};
  const review=await reviewSentence(llm,text,primary);
  assert.equal(calls,3);
  assert.equal(review.status,'ask');
  assert.equal(review.votes,0);
  for(const clue of ['铆丁','海边、固定']){
    const result=await reviewRelations({chat:async()=>({content:JSON.stringify({issue:{...suggestion,clue}})})},text,primary);
    assert.equal(result.status,'reject');
  }
});
test('关系复核只短重试一次，失败时保留原转写',async()=>{
  const modes=[];
  const result=await reviewRelations({chat:async req=>{modes.push(req.directAnswer);throw Error();}},'这是一只木箱',['这是一只木箱']);
  assert.deepEqual(modes,[false,true]);
  assert.equal(result.status,'keep');
  assert.equal(result.relationStatus,'unavailable');
});
test('线索可以引述前后分句，但填回去的字不能自己充当证据',()=>{
  const issue={heard:'木箱',candidate:'目箱',kind:'term'};
  const text='看到木箱外壳破损';
  for(const clue of ['“看到”“外壳破损”','看到【空缺】外壳破损','看到目箱外壳破损'])
    assert.equal(relationClueMatches(text,{...issue,clue}),true);
  assert.equal(relationClueMatches(text,{...issue,clue:'【空缺】目箱'}),false);
});

test('姓名即使有多数票也须确认，接受多音字候选',async()=>{
  const text='请联系沈重', other='请联系沈仲', issue={heard:'沈重',candidate:'沈仲',kind:'name'};
  const r=await weighSentenceSuggestion(text,[other,other,text],issue);
  assert.equal(r.status,'ask');
  assert.equal(applySentenceReview(r,text,{allowQuestion:false}).text,text);
  assert.equal(applySentenceReview(r,text,{protectedWords:['沈重']}).field,undefined);
});
test('整句候选有多个声学来源才能直接选用，复听失败沿用确认',async()=>{
  const text='这个箱子是目箱',correct='这个箱子是木箱', issue={heard:'目箱',candidate:'木箱',kind:'term'};
  const r=await weighSentenceSuggestion(text,[correct,text,correct],issue);
  assert.equal(applySentenceReview(r,text).text,correct);
  const novel=await weighSentenceSuggestion(text,[text,text],issue,async()=>{throw Error('unavailable');});
  assert.deepEqual(applySentenceReview(novel,text).field.options,['目箱','木箱']);
  const backed=await weighSentenceSuggestion(text,[text,text],issue,async()=>correct);
  assert.equal(backed.status,'edit');
});
test('服务超时、非 JSON 或跨度不唯一时保留原话',async()=>{
  for(const llm of [{chat:async()=>{throw Error();}},{chat:async()=>({content:'无'})}]){
    assert.equal((await reviewSentence(llm,'目箱',['目箱'])).status,'unavailable');
  }
  assert.equal((await weighSentenceSuggestion('目箱和目箱',['木箱和木箱'],{heard:'目箱',candidate:'木箱',kind:'term'})).status,'reject');
});
