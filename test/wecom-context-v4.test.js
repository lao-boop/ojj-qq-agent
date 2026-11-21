import test from 'node:test';
import assert from 'node:assert/strict';
import {relatedRecords,projectKeys} from '../src/wecom-context.js';
import {gradeQuestions,publicQuestions,questionSet} from '../experiments/secretary/business-eval.js';
import {writeScheduledBriefing,validateDirectBriefing} from '../src/wecom-scheduled-briefing.js';
const ms=86400000;
const r=(id,seq,text,extra={})=>({id,seq,text,sender:'lin',chatId:'sales',group:true,botId:'bot',receivedAt:30*ms,...extra});
test('project context can recall older cross-chat reports, but cannot cross explicit projects, bot or owner',()=>{
 const current=r('new',20,'LC-31今年合同、定金和尾款的最新情况');
 const archive=[r('good',1,'LC-31今年合同已经签署，尾款未到账',{chatId:'finance',sender:'zhou',receivedAt:10*ms}),r('wrong-project',2,'LC-32今年合同已经签署，定金尾款到账'),r('wrong-bot',3,'LC-31合同已签',{botId:'other'}),r('owner',4,'LC-31合同已签',{sender:'owner'}),r('future',21,'LC-31合同取消'),r('expired',5,'LC-31合同已签',{receivedAt:-ms})];
 const found=relatedRecords([current],archive,{eligible:x=>x.botId==='bot'&&x.sender!=='owner'});
 assert.deepEqual(found.map(r=>r.id),['good']);
 assert.deepEqual(projectKeys('LC-31与LC-32，不混LC-31'),['LC-31','LC-32']);
});
test('same customer or person is insufficient to join different private conversations without project codes',()=>{
 const current=r('new',10,'北辰合同付款小周已确认',{chatId:'lin',group:false});
 const old=r('old',1,'北辰合同付款小周已确认',{chatId:'zhou',group:false});
 assert.deepEqual(relatedRecords([current],[old],{eligible:()=>true}),[]);
});
test('lexical retrieval remains bounded and does not decide which contradictory source is true',()=>{
 const current=r('new',20,'LC-31通电情况');
 const old=[r('a',1,'LC-31物业说已通电'),r('b',2,'LC-31值班员说未通电')];
 const found=relatedRecords([current],old,{eligible:()=>true});assert.equal(found.length,2);
 assert.equal(relatedRecords([current],old,{eligible:()=>true,limit:1}).length,1);
});
test('question grading separates a correct guess, missing evidence, false citation and supported answer',()=>{
 const c={questions:[{id:'q',question:'已签吗',options:['已签','未签'],answer:'已签',proof:[['gold','已经签署']]}]};
 const qs=questionSet(c,'seed'),gold={id:'M1',text:'合同已经签署'};
 assert.equal(publicQuestions(qs)[0].correct,undefined);assert.equal(publicQuestions(qs)[0].proof,undefined);
 const response=evidence=>({answers:[{id:'q',choice:qs[0].correct,evidence}]});
 let g=gradeQuestions(response([]),qs,[],{gold:'M1'})[0];assert.ok(g.correct);assert.equal(g.evidenceAvailable,false);assert.equal(g.grounded,false);
 g=gradeQuestions(response([{source:'M1',quote:'合同没有签'}]),qs,[gold],{gold:'M1'})[0];assert.equal(g.validCitation,false);
 g=gradeQuestions(response([{source:'M1',quote:gold.text}]),qs,[gold],{gold:'M1'})[0];assert.ok(g.grounded);
 assert.doesNotThrow(()=>gradeQuestions(response([null,{source:'M1',quote:42}]),qs,[gold],{gold:'M1'}));
});
test('v4 preserves speaker and chat provenance and rejects invented source quotes',async()=>{
 const messages=[{id:'old',speaker:'小周',speakerId:'zhou',chatId:'finance',contextOnly:true,text:'LC-31只收定金，尾款未到账。'},
  {id:'new',speaker:'小何',speakerId:'he',chatId:'legal',contextOnly:false,text:'LC-31合同刚签了，月付问的是明年。'}];
 let received;
 const raw={paragraphs:[{text:'LC-31合同已签，按月付款问的是明年；尾款仍未到账。',evidence:messages.map(m=>({source:m.id,quote:m.text}))}]};
 const result=await writeScheduledBriefing({messages,llm:{async chat(input){received=input;return {content:JSON.stringify(raw)};}}});
 assert.deepEqual(JSON.parse(received.messages[1].content).messages,messages);
 assert.equal(received.maxAttempts,1);assert.equal(received.timeoutMs,60000);
 assert.deepEqual(result.sources,['old','new']);
 const invented=structuredClone(raw);invented.paragraphs[0].evidence[0].quote='尾款已到账';
 assert.throws(()=>validateDirectBriefing(invented,messages),/引文/);
});
test('v4 propagates transport failure without another paid request',async()=>{
 const failure=Error('offline'),messages=[{id:'new',text:'LC-31今天已签署。'}];let calls=0;
 await assert.rejects(()=>writeScheduledBriefing({messages,llm:{async chat(){calls++;throw failure;}}}),e=>e===failure);
 assert.equal(calls,1);
});
