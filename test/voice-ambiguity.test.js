import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewAmbiguity,applySentenceReview} from '../src/voice-sentence-review.js';
import {VoiceClarifications} from '../src/voice-clarification.js';
import {resolveVoiceVocabulary} from '../src/voice-vocabulary.js';
import {verifyAnchoredSpelling} from '../src/voice-place-evidence.js';

const keep={status:'keep'};
const noIssue={chat:async()=>({content:'{"issue":null}'})};
test('先核实导致人物或语气改变的分歧，已确认建议优先',async()=>{
  const text='爸爸把信寄出去了',alt='发吧，把信寄出去了';
  const reads=[alt,alt,text,text,'发爸把信寄出去了'];
  const decision=await reviewAmbiguity(noIssue,text,reads,keep);
  assert.deepEqual(applySentenceReview(decision,text).field.options,['爸爸','发吧']);
  assert.equal(applySentenceReview(decision,text,{protectedWords:['爸爸']}).field,undefined);
  assert.equal(await reviewAmbiguity(noIssue,text,[text,text,text],keep),keep);
});
test('开放式追问只替换疑段并接受直接输入',async()=>{
  const text='检查员查获假样酒的包装';
  const reads=[text,text,text.replace('样酒','洋酒'),text.replace('样酒','羊酒'),text.replace('样酒','酒')];
  const decision=await reviewAmbiguity(noIssue,text,reads,keep);
  const {field}=applySentenceReview(decision,text);
  assert.equal(field.open,true);
  const flow=new VoiceClarifications();
  const final=await flow.confirm('group/user',text,[field],prompt=>{
    assert.ok(!prompt.includes('还是'));
    assert.equal(flow.answer('group/user','不清楚'),false);
    assert.ok(flow.answer('group/user','洋酒'));
  });
  assert.equal(final,'检查员查获假洋酒的包装');
});
test('多数票只按独立模型计数并按上下文定位',async()=>{
  const text='我的笔名是晴川今天用它署名',other=text.replace('晴川','清川');
  const profile={correct:(_key,t)=>({text:t,edits:[],related:[]})};
  const field={start:5,end:7,options:['晴川','清川'],label:'用词'};
  const resolve=primary=>resolveVoiceVocabulary(profile,'u',text,[field],async()=>[],
    {primary,readings:[text,other],judge:async()=>['清川']});
  assert.equal((await resolve([text,text,text,text,other])).text,text);
  assert.equal((await resolve([other,text])).text,other);
});
test('短句动作槽有多个互不相同的声学读法时只问该处',async()=>{
  const text='两人探新路',reads=[text,text,'两人叹心路','两人谈心录','两人探心录'];
  const result=await reviewAmbiguity(noIssue,text,reads,keep);
  assert.deepEqual(applySentenceReview(result,text).field.options,['探新路']);
  assert.equal(await reviewAmbiguity(noIssue,text,[text,text,text,text,reads[2]],keep),keep);
});
test('核验相关镇名与引文须有附近原文，冲突时保留',async()=>{
  const search=async()=>[{url:'https://example.gov.cn/atlas',title:'地图'}];
  assert.equal((await verifyAnchoredSpelling('南合镇','西林镇','neighbor',search,async()=>'西林镇东接南河镇。')).value,'南河镇');
  assert.equal(await verifyAnchoredSpelling('南合镇','西林镇','neighbor',search,async()=>'西林镇、南合镇、南河镇。'),null);
  assert.equal((await verifyAnchoredSpelling('青风','明月来','quote-before',search,async()=>'清风，明月来。')).value,'清风');
  assert.equal(await verifyAnchoredSpelling('青风','明月来','quote-before',search,async()=>'清风起。明月来。'),null);
});
