// Bounded lexical candidates, not a fact store or proof that two messages concern the same event.
const COMMON = new Set(['今天','明天','现在','已经','还没','我们','这个','项目','确认','情况','一下','刚刚','之前','同事']);
export function projectKeys(text) {
  // Explicit project codes allow cross-conversation recall. Names/people alone do not.
  return [...new Set(String(text).match(/\b[A-Z]{2,8}-\d{2,8}\b/g)||[])];
}
function features(text) {
  const result=new Set();
  for(const run of String(text).toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9]+(?:-[a-z0-9]+)*/g)||[]){
    if(/^[a-z0-9]/.test(run)){if(run.length>=3)result.add(run);continue;}
    for(const n of [2,3,4])for(let i=0;i+n<=run.length;i++){
      const token=run.slice(i,i+n);if(!COMMON.has(token))result.add(token);
    }
  }
  return result;
}
export function relatedRecords(records, archive, {eligible, limit=6, maxAgeMs=30*86400000}={}) {
  if(!records.length || limit<1)return [];
  const earliest=Math.min(...records.map(r=>r.seq));
  const queries=records.map(r=>({record:r,keys:projectKeys(r.text),terms:features(r.text)}));
  const candidates=archive.filter(p=>eligible(p) && p.seq<earliest && queries.some(q=>
    p.receivedAt<=q.record.receivedAt && q.record.receivedAt-p.receivedAt<=maxAgeMs &&
    ((p.chatId===q.record.chatId && p.group===q.record.group) || q.keys.some(k=>projectKeys(p.text).includes(k)))));
  const docs=candidates.map(r=>({r,terms:features(r.text),keys:projectKeys(r.text)}));
  const df=new Map();for(const d of docs)for(const t of d.terms)df.set(t,(df.get(t)||0)+1);
  const ranked=[];
  for(const d of docs){
    let score=0;
    for(const q of queries){
      const sameChat=d.r.chatId===q.record.chatId && d.r.group===q.record.group;
      const sameProject=q.keys.some(k=>d.keys.includes(k));
      if(!sameChat && !sameProject)continue;
      // An explicitly different project code must not be pulled in by shared generic words.
      if(q.keys.length && d.keys.length && !sameProject)continue;
      const shared=[...q.terms].filter(t=>d.terms.has(t));
      const rare=shared.some(t=>(df.get(t)||0)<=Math.max(2,Math.ceil(docs.length*.05)));
      if(!sameProject && (shared.length<3 || !rare))continue;
      const weight=shared.reduce((s,t)=>s+Math.log(1+docs.length/(df.get(t)||1)),0);
      const candidate=(sameProject?20:0)+weight/Math.sqrt(Math.max(1,d.terms.size));
      score=Math.max(score,candidate);
    }
    if(score>0)ranked.push({r:d.r,score});
  }
  return ranked.sort((a,b)=>b.score-a.score || b.r.seq-a.r.seq).slice(0,limit).map(x=>x.r);
}
