// Bounded lexical candidates, not a fact store or proof that two messages concern the same event.
const COMMON = new Set(['今天','明天','现在','已经','还没','我们','这个','项目','确认','情况','一下','刚刚','之前','同事']);
export function projectKeys(text) {
  // Explicit project codes allow cross-conversation recall. Names/people alone do not.
  return [...new Set(String(text).toUpperCase().match(/\b(?:[A-Z]{2,8}-\d{2,8}|(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{13}[0-9]{4})\b/g)||[])];
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

// Search over archived wording. Short Chinese phrases can occur inside a longer boss question.
function archiveTerms(text) {
  const tokens = new Map();
  const add = t => tokens.set(t, (tokens.get(t) || 0) + 1);
  for (const [run] of String(text).toLowerCase().matchAll(/[\u3400-\u9fff]+|[a-z0-9]+(?:-[a-z0-9]+)*/g)) {
    if (/^[a-z0-9]/.test(run)) { add(run); continue; }
    for (let i=1; i<run.length; i++) {
      const word = run.slice(i-1,i+1);
      if (!COMMON.has(word)) add(word);
    }
  }
  return tokens;
}

// Strip question framing before looking for an archive subject. Words such as
// “后来” say when to look, but provide no evidence that a topic is unchanged.
const questionFrame = /有没有|能不能|可不可以|是不是|是否|能否|现在|目前|当时|上次|原先|之前|后来|今天|明天|昨天|眼下|接下来|具体|到底|究竟|如何|怎么|什么|哪[一个些项件位]|这[个件项笔边块]|那[个件项笔边块]|两[笔件项]|负责[人]?|谁|负责|跟进|处理|安排|办理|最新|进展|情况|消息|事情|事项|员工|同事|老板|请示|汇报|确认|决定|拍板|审批|接手|完工|完成|依据|说法|打算|待办|还要|还需|能给|更新|剩下|需要|告诉|说明|那|这|我|你|他|她|的|吗|呢|了|是|要|还|在|有|没|和|跟|就|都|请/gu;

export class ArchiveSearch {
  constructor() {
    this.postings = new Map();
    this.documents = new Map();
    this.headings = new Map();
    this.commaPrefixes = new Map();
    this.speakers = new Set();
    this.totalLength = 0;
  }
  update(r) {
    this.speakers.add(r.sender);
    if (r.identity?.name) this.speakers.add(r.identity.name);
    const headingMatch=/^([^，,。：:；;\n]{2,40})[。：:]/u.exec(r.text);
    // A stand-alone reply sentence can recur verbatim in independent matters.
    const heading=headingMatch && (headingMatch[0].length<r.text.trimEnd().length || !r.replyMsgid) ? headingMatch[1].trim() : null;

    const prefix=/^([^，,。：:；;\n]{3,40})[，,]/u.exec(r.text)?.[1].trim();
    const old = this.documents.get(r.id);
    if (old?.prefixRoot) {
      const group=this.commaPrefixes.get(old.prefix);
      group.delete(r.id);
      if (!group.size) this.commaPrefixes.delete(old.prefix);
    }
    const prefixRoot=Boolean(prefix && !r.replyMsgid && !r.quote);
    if (prefixRoot) {
      if (!this.commaPrefixes.has(prefix)) this.commaPrefixes.set(prefix,new Set());
      this.commaPrefixes.get(prefix).add(r.id);
    }
    if (old) {
      if (old.heading) {
        const group=this.headings.get(old.heading);
        group.delete(r.id);
        if (!group.size) this.headings.delete(old.heading);
      }
      this.totalLength -= old.length;
      for (const term of old.terms.keys()) {
        const hits = this.postings.get(term);
        hits.delete(r.id);
        if (!hits.size) this.postings.delete(term);
      }
    }
    const terms = archiveTerms([r.text,r.quote,r.extractedText,r.imageReading].filter(Boolean).join('\n'));
    let length = 0;
    for (const [term,tf] of terms) {
      if (!this.postings.has(term)) this.postings.set(term,new Map());
      this.postings.get(term).set(r.id,tf);
      length += tf;
    }
    if (heading) {
      if (!this.headings.has(heading)) this.headings.set(heading,new Set());
      this.headings.get(heading).add(r.id);
    }
    this.documents.set(r.id,{terms,length,heading,prefix,prefixRoot,seq:r.seq});
    this.totalLength += length;
  }
  isSpeakerLabel(text) {
    const name = text.replace(/(?:同事)?(?:刚才|刚刚)?(?:说|回|回复|表示|提到|补充|汇报)$/u,'');
    return this.speakers.has(text) || this.speakers.has(name);
  }
  subjectIn(question) {
    const found = new Set();
    for (let start=0; start<question.length; start++) {
      for (let n=2; n<=40 && start+n<=question.length; n++) {
        const part=question.slice(start,start+n);
        if ((this.headings.has(part) || this.commaPrefixes.get(part)?.size>=2) && !this.isSpeakerLabel(part)) found.add(part);
      }
    }
    const longest=[...found].filter(term=>![...found].some(other=>other!==term && other.includes(term)));
    return longest.length===1 ? longest[0] : undefined;
  }
  exactCandidates(subject) {
    const lists = [...archiveTerms(subject).keys()].map(term => this.postings.get(term));
    if (!lists.length || lists.some(list => !list)) return [];
    return lists.sort((a,b) => a.size-b.size)[0].keys();
  }
  scores(query) {
    const ranked = new Map();
    const N = this.documents.size;
    const average = this.totalLength / N || 1;
    for (const term of archiveTerms(query).keys()) {
      const hits = this.postings.get(term);
      if (!hits) continue;
      const weight = Math.log1p((N-hits.size+0.5)/(hits.size+0.5));
      for (const [id,tf] of hits) {
        const length = this.documents.get(id).length;
        const score = weight*tf*2.2/(tf+1.2*(0.25+0.75*length/average));
        ranked.set(id,(ranked.get(id)||0)+score);
      }
    }
    return ranked;
  }

  topicHits(question, accept, recent) {
    const terms = question.replace(questionFrame,' ');
    const scores = this.scores(terms);
    // A compound like a location plus an object can be separated by modifiers
    // in employee speech. Prefer hits covering both ends over a shared suffix.
    const phrases = terms.match(/[\u3400-\u9fff]{4,}/gu) || [];
    const hits = [];
    for (const [id, score] of scores) {
      if (!accept(id)) continue;
      const doc = this.documents.get(id).terms;
      const span = phrases.some(p=>doc.has(p.slice(0,2)) && doc.has(p.slice(-2)));
      hits.push({id,score:span ? score*2 : score});
    }
    hits.sort((a,b) => b.score-a.score || this.documents.get(b.id).seq-this.documents.get(a.id).seq);
    const strong = hits.filter(hit => hit.score >= hits[0].score * 0.55);
    const seeds = strong.slice(0,6).map(hit=>hit.id);
    if (recent) {
      const updates = strong.filter(hit=>recent(hit.id)).slice(0,2);
      for (const {id} of updates) if (!seeds.includes(id)) seeds.push(id);
    }
    return seeds;
  }
  hasSubjectHint(question) {
    return /[\p{L}\p{N}]{2}/u.test(question.replace(questionFrame,' '));
  }
  matchesDetails(question, id) {
    const doc = this.documents.get(id);
    if (!doc) return false;
    const terms = archiveTerms(question.replace(questionFrame,' '));
    return [...terms.keys()].filter(t=>doc.terms.has(t) && this.postings.get(t).size <= Math.max(3,this.documents.size*0.1)).length >= 2;
  }

  // Overlap between a located original and a nearby employee update. Give a
  // shared business object more weight than common words like “已经”.
  sharedDetail(a, b) {
    const first = this.documents.get(a)?.terms;
    const second = this.documents.get(b)?.terms;
    if (!first || !second) return 0;
    let detail = 0;
    for (const term of first.keys()) {
      const df = this.postings.get(term).size;
      if (second.has(term) && df <= Math.max(3, this.documents.size * 0.05))
        detail += Math.log1p(this.documents.size / df);
    }
    return detail;
  }
}
