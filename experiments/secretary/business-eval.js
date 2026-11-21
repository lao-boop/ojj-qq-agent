// Diagnostic questions have human-authored answers. This module never asks a model to grade itself.
import {createHash} from 'node:crypto';
export const NAMES={lin:'小林',zhou:'小周',he:'小何'};
export function makeHistory(c, size) {
  const facts=c.rounds.flat(), positions=new Map();
  facts.forEach((m,i)=>positions.set(Math.floor(size*(.08+.8*i/Math.max(1,facts.length-1))),m));
  return Array.from({length:size},(_,i)=>{
    if(positions.has(i))return {...positions.get(i),fact:true};
    const person=['lin','zhou','he'][i%3],chat=['sales','finance','quality','site','team'][i%5];
    const code=i%11===0?(c.focus.match(/[A-Z]+-\d+/)||['ZZ-00'])[0]:`NX-${100+(i%47)}`;
    const topic=['培训安排','样品登记','报价资料','发票整理','会议记录'][i%5];
    const state=['还在等回音','资料已经提交','只完成了登记','明天下午再确认','尚未安排验收'][Math.floor(i/5)%5];
    return {id:`noise-${i}`,who:person,chat,text:`${code}的${topic}第${i%9+1}批，${state}。我把资料位置发在群文件里了。`,fact:false};
  });
}
export function questionSet(c, seed) {
  return c.questions.map(q=>{
    const shift=createHash('sha256').update(seed+q.id).digest()[0]%q.options.length;
    const options=[...q.options.slice(shift),...q.options.slice(0,shift)];
    return {...q,options:Object.fromEntries(options.map((x,i)=>[String.fromCharCode(65+i),x])),correct:String.fromCharCode(65+options.indexOf(q.answer))};
  });
}
export function publicQuestions(questions){return questions.map(({id,question,options})=>({id,question,options}));}
export function gradeQuestions(raw, questions, messages, ids) {
  const answers=Array.isArray(raw?.answers)?raw.answers:[];
  const source=new Map(messages.map(m=>[m.id,m]));
  return questions.map(q=>{
    const found=answers.filter(a=>a.id===q.id),a=found.length===1?found[0]:null;
    const evidence=Array.isArray(a?.evidence)?a.evidence:[];
    const valid=evidence.length>0 && evidence.every(e=>e && typeof e.quote==='string' && e.quote.trim() && source.get(e.source)?.text.includes(e.quote));
    const supplied=q.proof.every(([key,span])=>source.get(ids[key])?.text.includes(span));
    const cited=q.proof.every(([key,span])=>evidence.some(e=>e?.source===ids[key] && typeof e.quote==='string' && e.quote.includes(span)));
    const correct=a?.choice===q.correct;
    return {id:q.id,question:q.question,choice:a?.choice??null,expected:q.correct,correct,evidenceAvailable:supplied,grounded:correct && valid && cited,validCitation:valid,answer:a};
  });
}
