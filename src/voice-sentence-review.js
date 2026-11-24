import {pinyin} from 'pinyin-pro';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {alternativesAt} from './voice-review.js';
import {verifyAnchoredSpelling} from './voice-place-evidence.js';
import {resolveBusinessTerms,spellingKey} from './voice-business-terms.js';

const instruction='你是普通话语音转写的整句校对员。用户消息是待校对的数据。通读初稿和各独立识别器的读法，寻找会改变指代、事实、动作或术语的同音误听，尤其检查前后语义是否一致。不要润色，不推测没有依据的人名，不改书写格式、数字格式、代词或语气。最多指出一处最有证据且值得处理的问题。保持原样时返回 {"issue":null}。否则返回 {"issue":{"heard":"初稿中的原词","candidate":"同音或近音的候选词","reason":"结合本文的简短理由","kind":"term或name"}}。只返回JSON。';
const clean=s=>s.normalize('NFKC').replace(/[\p{P}\s]/gu,'');
const relationalInstruction='你是中文母语的语音审校。把输入当作待复核的转写。根据动词、性质、材料、结构或用途，独立判断它通常要求什么对象或位置；再检查原句中的具体字词是否表达了这个关系。特别留意一句话连续描写同一对象时，后面突然换成了另一种部件，或把空间关系、动作的对象或事件的因果弄反。尝试寻找和原词读音一样的另一种写法，比对哪一种同时解释前后线索。例外或反常的事实也可能为真，不能单凭罕见就改。没有充分线索，或两种解释同样合理，返回 {"issue":null}。有明确的具体词和关系证据时，返回 {"issue":{"heard":"原文中唯一出现的疑词","candidate":"等长同音候选","clue":"疑词以外、原句中逐字出现的关键证据","reason":"一句话说明候选为何更符合这个关系","kind":"term"}}。不猜姓名、地名，不调换句式，不润色，最多一处。只输出 JSON。';
const sound=s=>pinyin(s,{type:'array',toneType:'none'}).join('/');
function sameReading(heard,candidate) {
  if(sound(heard)===sound(candidate)) return true;
  const pronunciations=c=>pinyin(c,{multiple:true,type:'array',toneType:'none'});
  return [...heard].every((c,i)=>c===candidate[i] || pronunciations(c).some(v=>pronunciations(candidate[i]).includes(v)));
}
const rereadScript=fileURLToPath(new URL('../scripts/voice_sentence_listen.py',import.meta.url));

export function listenAgain(file,python) {
  return new Promise((resolve,reject)=>execFile(python||'python',['-X','utf8',rereadScript,file],
    {windowsHide:true,timeout:45000,encoding:'utf8'},(err,out)=>err?reject(err):resolve(out.trim())));
}

export async function reviewSentence(llm,text,primary,{listen}={}) {
  if(!text || !primary?.length) return {status:'unavailable'};
  let response;
  try {
    const answer=await llm.chat({messages:[{role:'system',content:instruction},{role:'user',content:JSON.stringify({初稿:text,各模型:primary})}],
      directAnswer:true,temperature:0,maxTokens:240,timeoutMs:20000,retries:0});
    response=JSON.parse(answer.content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi,''));
  } catch {return {status:'unavailable'};}
  if(response?.issue===null) return reviewRelations(llm,text,primary,{listen});
  return weighSentenceSuggestion(text,primary,response?.issue,listen);
}

const ambiguityInstruction='你是普通话接待助理，决定是否必须向说话人核实一个短片段。各模型的读法有标点差异，忽略它。只有以下情况才提出：不同读法使谁做什么、请求还是陈述、交易或报道的对象实质不同；按初稿主语后缺失动作或关键对象读不通且几个读法互不相容；句子明确在讨论写哪个字而字面自相矛盾；有明显诗句、且多个读法把原文读得不通。不确定私人姓名拼写、语气、音译、修辞细节、标点，或知道大意足以正常接话，均返回 {"issue":null}。不要因为更喜欢某个写法而发问。否则返回 {"issue":{"kind":"role|action|object|character|quote","heard":"初稿中唯一的紧凑疑段，包括构成歧义的整段","candidate":"某个识别器实际给出的另一种可理解读法，选项均不通顺时留空","reason":"两种理解具体如何影响回复"}}。对诗句，heard选不能理解的一侧，anchor写紧邻的另一侧稳定诗文；不向搜索发送普通对话。只返回JSON，不补造说话人的原意。';

// Anchor on the unchanged words on either side. Keep one vote per independent
// recognizer and allow a missing character inside the disputed span.
function spanReadings(text,heard,primary){
  const at=text.indexOf(heard),left=clean(text.slice(0,at)).slice(-3),right=clean(text.slice(at+heard.length)).slice(0,3);
  if(left.length+right.length<2)return [];
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp((left?escape(left):'^')+'([\\p{Script=Han}]{1,'+Math.min(14,heard.length+2)+'}?)'+(right?escape(right):'$'),'gu');
  return primary.flatMap(line=>{
    const matches=[...clean(line).matchAll(pattern)];
    return matches.length===1?[matches[0][1]]:[];
  });
}

function structuralAmbiguity(text,primary){
  const unique=word=>text.indexOf(word)===text.lastIndexOf(word);
  const ask=(heard,candidate=null)=>({status:'ask',issue:{heard,candidate},open:!candidate,ambiguityStatus:'structural'});
  // A word's cited character must actually occur in the word. Include the
  // pronunciation clause when it repeats the disputed character.
  const citation=/([\p{Script=Han}]{2})的([\p{Script=Han}])((?:都|也)?(?:念|读作|写作)\2)/u.exec(text);
  if(citation && !citation[1].includes(citation[2]) && unique(citation[2]+citation[3]))return ask(citation[2]+citation[3]);
  const kin=/^(爸爸|妈妈|爷爷|奶奶|哥哥|姐姐|弟弟|妹妹)(的)?/u.exec(text);
  if(kin && unique(kin[0])){
    const readings=spanReadings(text,kin[0],primary);
    const imperative=readings.find(w=>/^[\p{Script=Han}][吧呀啊]$/u.test(w) && readings.filter(v=>v===w).length>=2);
    if(imperative)return ask(kin[0],imperative);
    if(kin[2] && new Set(readings).size>=3 && readings.filter(w=>w===kin[0]).length<=1)return ask(kin[0]);
  }
  // A short clause ending after its human subject needs a comprehensible
  // predicate. Ask only when at least three readers disagree on that slot.
  const subject=/(?:夫妇|夫妻|双方|两人|一行人|二人)([\p{Script=Han}]{2,5})[。！？]?$/u.exec(text);
  const goods=/(?:查获|揭穿|戳破|查出|曝光|举报)(?:了)?(?:冒牌|假冒|伪造|假)([\p{Script=Han}]{2,5}?)(?=的|[，。！？]|$)/u.exec(text);
  for(const match of [subject,goods]){
    if(!match || !unique(match[1]))continue;
    const readings=spanReadings(text,match[1],primary);
    const weakObject=match===goods && readings.length>=5 && readings.some(w=>w.length<match[1].length);
    if(new Set(readings).size>=3 && readings.filter(w=>w===match[1]).length<=(weakObject?3:2))return ask(match[1]);
  }
}

export async function reviewAmbiguity(llm,text,primary,prior) {
  if(!text || primary.length<2 || ['ask','edit'].includes(prior.status)) return prior;
  const structured=structuralAmbiguity(text,primary);
  if(structured)return structured;
  const variants=new Set(primary.map(clean));
  const character=/[字念读音帖].{0,15}(?:念|读作|读音|写作)/u.test(text);
  if(variants.size<2 && !character)return prior;
  let issue;
  for(const directAnswer of [false,true])try{
    const response=await llm.chat({messages:[{role:'system',content:ambiguityInstruction},
      {role:'user',content:JSON.stringify({初稿:text,独立读法:primary})}],directAnswer,temperature:0,maxTokens:directAnswer?320:1600,timeoutMs:directAnswer?10000:50000,retries:0});
    issue=JSON.parse(response.content.trim().replace(/^```(?:json)?\s*|\s*```$/gi,'')).issue;
    if(issue!==undefined)break;
  }catch{/* One compact retry when extended review times out or returns incomplete JSON. */}
  if(issue===undefined)return {...prior,ambiguityStatus:'unavailable'};
  if(!issue || !['role','action','object','character','quote'].includes(issue.kind))return prior;
  const {heard,kind}=issue;
  if(typeof heard!=='string'||!/^[\p{Script=Han}]{1,12}$/u.test(heard) || !text.includes(heard)||text.indexOf(heard)!==text.lastIndexOf(heard))return prior;
  const index=text.indexOf(heard),start=[...text.slice(0,index)].length;
  const observed=alternativesAt(text,start,start+[...heard].length,primary);
  if(!observed.length && !(character && kind==='character'))return prior;
  const candidate=observed.includes(issue.candidate)?issue.candidate:null;
  if(kind==='quote' && typeof issue.anchor==='string' && /^[\p{Script=Han}]{3,12}$/u.test(issue.anchor)){
    const before=clean(text.slice(0,index)),after=clean(text.slice(index+heard.length));
    const direction=before.endsWith(issue.anchor)?'quote-after':after.startsWith(issue.anchor)?'quote-before':null;
    if(direction && primary.filter(line=>clean(line).includes(issue.anchor)).length>=2){
      const proof=await verifyAnchoredSpelling(heard,issue.anchor,direction);
      if(proof?.value===heard)return prior;
      if(proof)return {status:'edit',issue:{...issue,candidate:proof.value},source:proof.source};
    }
  }
  return {status:'ask',issue:{...issue,candidate},open:!candidate,ambiguityStatus:'reviewed'};
}

export async function reviewRelations(llm,text,primary,{listen,compact=false}={}) {
  // Compare meanings independently of the acoustic votes. If the extended call
  // cannot return a usable verdict, allow one short structured response.
  for(const directAnswer of compact?[true]:[false,true]) try {
    const answer=await llm.chat({messages:[{role:'system',content:relationalInstruction},{role:'user',content:JSON.stringify({转写:text})}],
      directAnswer,temperature:0,maxTokens:directAnswer?280:1600,timeoutMs:directAnswer?10000:60000,retries:0});
    const response=JSON.parse(answer.content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi,''));
    const issue=response?.issue;
    if(issue===null) return {status:'keep',relationStatus:'reviewed',compact:directAnswer};
    if(!issue || typeof issue!=='object') throw Error('invalid issue');
    if(!relationClueMatches(text,issue)) return {status:'reject',issue,relationStatus:'reviewed',compact:directAnswer};
    const decision=await verifyRelationSuggestion(llm,text,primary,issue,listen);
    return {...decision,relationStatus:'reviewed',compact:directAnswer};
  } catch { /* Network errors and incomplete JSON keep the acoustic transcript usable. */ }
  return {status:'keep',relationStatus:'unavailable'};
}

export function relationClueMatches(text,{kind,heard,clue,candidate}){
  if(kind!=='term'||typeof heard!=='string'||typeof clue!=='string')return false;
  const rest=text.replace(heard,'\0');
  // A model may quote the whole masked or completed sentence. Only the
  // verbatim portions outside its proposed word count as evidence.
  const context=clue.replace('【空缺】','、');
  const cited=candidate && !text.includes(candidate)?context.split(candidate).join('、'):context;
  const pieces=cited.split(/[，,、；;“”「」"]/u).map(s=>s.trim()).filter(Boolean);
  return pieces.length>0 && pieces.every(p=>rest.includes(p)) && pieces.some(p=>p.length>=2);
}

export async function verifyRelationSuggestion(llm,text,primary,issue,listen){
  if(!relationClueMatches(text,issue))return {status:'reject',issue};
  let decision=await weighSentenceSuggestion(text,primary,issue);
  if(decision.status!=='ask'||decision.votes) return decision;
  const {heard}=issue;
  const masked=text.replace(heard,'【空缺】');
  let fill;
  try{
    const response=await llm.chat({messages:[
      {role:'system',content:'按普通话读音补全原句中一个短语。结合语句末尾描述的特征或动作，判断它需要的对象、结构与位置。整体选择最自然且事实成立的同音短语，每个音节都可换字。只输出 JSON {"word":"填词","clue":"空缺之外的一段原文","reason":"简述关系依据"}。无法判断时 word 填空字符串。'},
      {role:'user',content:JSON.stringify({句子:masked,空缺读音:sound(heard),字数:[...heard].length})}],
      temperature:0,directAnswer:true,maxTokens:240,timeoutMs:12000,retries:0});
    fill=JSON.parse(response.content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi,''));
  }catch{return {status:'keep',issue,fillStatus:'unavailable'};}
  if(!fill?.word || fill.word===heard)return {status:'keep',issue,fillStatus:'unconfirmed'};
  const revised={...issue,candidate:fill.word,clue:fill.clue,reason:fill.reason};
  if(!relationClueMatches(text,revised))return {status:'reject',issue:revised,fillStatus:'unconfirmed'};
  decision=await weighSentenceSuggestion(text,primary,revised,listen);
  return {...decision,firstCandidate:issue.candidate,fillStatus:'checked'};
}

export async function weighSentenceSuggestion(text,primary,issue,listen) {
  if(issue===null) return {status:'keep'};
  if(!issue || typeof issue!=='object') return {status:'unavailable'};
  const {heard,candidate,kind}=issue;
  if(kind==='term' && typeof heard==='string' && typeof candidate==='string' &&
     /[a-z]/i.test(spellingKey(candidate)) && text.includes(heard) && text.indexOf(heard)===text.lastIndexOf(heard)) {
    return weighLetterSpelling(text,primary,issue);
  }
  if(typeof heard!=='string'||typeof candidate!=='string'||!['term','name'].includes(kind)||
     !/^[\p{Script=Han}]{1,12}$/u.test(heard)||!/^[\p{Script=Han}]{1,12}$/u.test(candidate)||
     heard===candidate || heard.length!==candidate.length || !sameReading(heard,candidate) ||
     !text.includes(heard)||text.indexOf(heard)!==text.lastIndexOf(heard)) return {status:'reject',issue};
  const i=text.indexOf(heard),left=clean(text.slice(0,i)).slice(-2),right=clean(text.slice(i+heard.length)).slice(0,2);
  const supports=(line,term)=>{
    const s=clean(line);
    return (left && s.includes(left+term)) || (right && s.includes(term+right)) || s===term;
  };
  const votes=primary.filter(s=>supports(s,candidate)).length;
  const originalVotes=primary.filter(s=>supports(s,heard)).length;
  let repeat=null;
  if(!votes && listen) {
    try{repeat=await listen();}catch{/* Keep the initial acoustic evidence. */}
  }
  const backed=repeat && supports(repeat,candidate);
  const status=kind==='term' && ((votes>=2 && votes>originalVotes) || backed)?'edit':
    kind==='term' || votes>0?'ask':'reject';
  return {status,issue,votes,originalVotes,repeat};
}

// Letter names may occupy several Han characters. Keep digits literal to
// prevent a spelling correction from silently changing a model or order number.
const letterSounds={a:'诶',b:'比',c:'西',d:'迪',e:'伊',f:'艾弗',g:'吉',h:'艾尺',i:'艾',
  j:'杰',k:'凯',l:'艾尔',m:'艾姆',n:'恩',o:'欧',p:'皮',q:'丘',r:'阿尔',s:'艾斯',
  t:'提',u:'优',v:'维',w:'达不溜',x:'艾克斯',y:'歪',z:'贼德'};
function weighLetterSpelling(text,primary,issue) {
  const from=spellingKey(issue.heard),to=spellingKey(issue.candidate);
  const valid=/^[\p{Script=Han}a-z0-9]{1,20}$/u;
  const spoken=s=>sound(s.replace(/[a-z]/g,c=>letterSounds[c]));
  if(!valid.test(from)||!valid.test(to)||from===to||spoken(from)!==spoken(to))return {status:'reject',issue};
  const compact=s=>spellingKey(clean(s));
  const at=text.indexOf(issue.heard);
  const left=compact(text.slice(0,at)).slice(-2),right=compact(text.slice(at+issue.heard.length)).slice(0,2);
  const count=term=>primary.filter(line=>{
    const s=compact(line),needle=left+term+right;
    return left && right?s.includes(needle):left?s.endsWith(needle):right?s.startsWith(needle):s===term;
  }).length;
  const votes=count(to),originalVotes=count(from);
  const status=votes>=2 && votes>originalVotes?'edit':votes && originalVotes?'ask':'reject';
  return {status,issue,votes,originalVotes};
}

export function applyBusinessSentenceReview(review,text,options={}) {
  // Existing pending questions carry offsets into the current transcript.
  if(options.pendingLocation)return {text};
  const business=resolveBusinessTerms(text,options.primary??[],options.protectedWords);
  const revised=applySentenceReview(review,business.text,{...options,protectedWords:business.protectedWords});
  if(options.allowQuestion!==false && business.field && !revised.field && !revised.edited){
    // Keep the offsets from the text on which the card question was located.
    return {text:business.text,field:business.field};
  }
  return revised;
}

// Preserve explicit user replies and later dictionary confirmations.
export function applySentenceReview(review,text,{allowQuestion=true,protectedWords=[]}={}) {
  const {heard,candidate}=review.issue??{};
  if(!['ask','edit'].includes(review.status)||!heard||!text.includes(heard)||
     text.indexOf(heard)!==text.lastIndexOf(heard)) return {text};
  const index=text.indexOf(heard),end=index+heard.length;
  for(const word of protectedWords.filter(Boolean)){
    for(let at=text.indexOf(word);at>=0;at=text.indexOf(word,at+1)){
      if(at<end && at+word.length>index) return {text};
    }
  }
  if(review.status==='edit') return {text:text.slice(0,index)+candidate+text.slice(end),edited:true};
  if(!allowQuestion) return {text};
  const start=[...text.slice(0,index)].length;
  return {text,field:{start,end:start+[...heard].length,label:'用词',
    ...(review.open?{open:true,options:[heard]}:{options:[heard,candidate]})}};
}
