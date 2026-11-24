import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';
import { publicPlaceSearch } from './websearch.js';
import { alternativesAt, semanticFields, sound } from './voice-review.js';
import {verifyPublicName, verifyAnchoredSpelling} from './voice-place-evidence.js';
import {applyCulturalTerms} from './voice-cultural-terms.js';

const person = /^[\p{Script=Han}·]{2,8}$/u;
const defaults = JSON.parse(fs.readFileSync(new URL('../data/voice-name-defaults.json',import.meta.url),'utf8'));
const require = createRequire(import.meta.url);
const regions = require('china-area-data');
const publicTerms = new Set();
for (const [parent, group] of Object.entries(regions)) {
  for (const full of Object.values(group)) {
    if (typeof full !== 'string' || full.length<2 || /辖区|直辖|自治区直辖/.test(full)) continue;
    publicTerms.add(full);
    if (parent==='86' || parent.endsWith('0000')) {
      const short=full.replace(/省$|市$/,'');
      if(short.length>=2) publicTerms.add(short);
    }
  }
}
const regionNames = new Intl.DisplayNames(['zh-CN'],{type:'region',fallback:'none'});
for(let a=65;a<=90;a++) for(let b=65;b<=90;b++) {
  const country=regionNames.of(String.fromCharCode(a,b));
  if(country && /^[\p{Script=Han}]{2,10}$/u.test(country)) publicTerms.add(country);
}
const geographicWords = [...publicTerms].sort((a,b)=>b.length-a.length);
const districtSpellings = new Map();
for (const full of publicTerms) {
  if (!/^[\p{Script=Han}]{2,4}[县区市]$/u.test(full)) continue;
  const stem=full.slice(0,-1), key=sound(stem);
  const names=districtSpellings.get(key) ?? new Set();
  names.add(stem);
  districtSpellings.set(key,names);
}
const reading = word => pinyin(word,{type:'array',toneType:'num'}).join(' ');

export class VoiceNames {
  constructor(file) {
    this.file = file;
    try {
      this.entries = new Map(Object.entries(JSON.parse(fs.readFileSync(file,'utf8'))));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.entries = new Map();
    }
  }

  add(key, name, heard) {
    if (!person.test(name)) return;
    const list = this.entries.get(key) ?? [];
    const aliases = new Set(list.find(e=>e.name===name)?.aliases ?? []);
    if (heard && heard !== name && person.test(heard)) aliases.add(heard);
    const record = {name, aliases:[...aliases]};
    const old = list.find(e=>e.name===name);
    if (old && old.aliases.length === aliases.size) return;
    const next = new Map(this.entries).set(key,[...list.filter(e=>e.name!==name),record]);
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    const temp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(next)), 'utf8');
    fs.renameSync(temp,this.file);
    this.entries = next;
  }

  correct(key, transcript, fields) {
    const options=fields.flatMap(f=>f.options ?? []);
    const entries=new Map(defaults.map(name=>[name,{name,aliases:[]}]));
    for (const e of this.entries.get(key) ?? []) entries.set(e.name,e);
    const relevant=new Set();
    const edits=[];
    let text='';
    for(let i=0;i<transcript.length;) {
      const candidates=[];
      for(const {name,aliases} of entries.values()) {
        const word=transcript.slice(i,i+name.length);
        if(word.length!==name.length || !person.test(word)) continue;
        if(word===name) { candidates.push({word,name}); continue; }
        const alias=aliases.includes(word);
        const alternative=options.some(o=>o.includes(name));
        const nameContext=/名叫|名为|名字是|通知|联系|发给|转给|采访|导演|演员|歌手|记者/.test(transcript.slice(Math.max(0,i-5),i)) ||
          /^(?:说|表示|认为|回应|出演|演唱|称|老师|女士|先生)/.test(transcript.slice(i+word.length));
        if(!alias && !alternative && !nameContext && !(name.length>=3 && [...name].filter((c,j)=>word[j]===c).length>=2)) continue;
        if(alias || reading(word)===reading(name)) candidates.push({word,name});
      }
      const exact=candidates.find(c=>c.word===c.name);
      const winner=exact ?? (candidates.length===1?candidates[0]:null);
      for(const c of candidates) relevant.add(c.name);
      if(!winner) {text+=transcript[i++];continue;}
      const {word,name}=winner;
      if(word!==name) edits.push({heard:word,value:name});
      text+=name;
      i+=word.length;
    }
    return {text,edits,related:[...relevant]};
  }
}

const placeEnd = '(?:博物馆|纪念馆|火车站|地铁站|广场|公园|景区|古镇|机场|大桥|园|桥|市|县|镇|村|站)';
const geoTerm = new RegExp('^[\\p{Script=Han}]{1,9}' + placeEnd + '$','u');
const inSentence = new RegExp('(?:图为|景点是|地名是|地点是|景区叫|导航到|位于|前往|要去|去)' +
  '([\\p{Script=Han}]{1,9}?' + placeEnd + ')(?=怎么|在哪|附近|广邀|游玩|参观|集合|[，。？！、\\s]|$)','u');

const privateLocation = /住址|家庭地址|我家|你家|门牌|单元|室号|保密|内部地址/;
function geographicFocus(text,readings) {
  if(privateLocation.test(text)) return null;
  const river=/(?:渡过|横渡|流经|跨过)([\p{Script=Han}]{1,4}?[江河])(?=[，。！？、\s]|$)/u.exec(text);
  const locality=/(?:就读于|位于|来自)([\p{Script=Han}]{2,4}?[乡镇县])([\p{Script=Han}]{2,6}?(?:小学|中学|码头|水库))/u.exec(text);
  if(river && locality){
    const term=river[1],start=[...text.slice(0,river.index+river[0].length-term.length)].length;
    const options=[term,...alternativesAt(text,start,start+[...term].length,readings)];
    return {term,start,options,topics:locality.slice(1,3),utterance:text};
  }
  const collection=/(?:馆藏(?:的)?|藏有|收藏(?:的|了)?|出土(?:的|了)?|展品名为|文物名为)([\p{Script=Han}]{1,12}?(?:兽座|编钟|铜镜|金印|石碑|俑|鼎|尊|簋|盘|瓶|壶|爵|璧|剑|图|帖|卷))(?=出自|现藏|来自|是|属于|[，。！？、\s]|$)/u.exec(text);
  const namedHall=/(?:参观(?:了)?|展厅叫|展厅名为|博物院的|博物馆的|六艺城的)([\p{Script=Han}]{1,6}?(?:展厅|厅|殿|阁|馆))(?=展示|展出|再现|位于|在|[，。！？、\s]|$)/u.exec(text);
  const feature=/(?:位于|地处|进入|抵达|穿过|流经|前往|导航到|与)([\p{Script=Han}]{1,6}?(?:盆地|海峡|海沟|庭院|山脉|河谷|湿地|隧道|大桥|村))(?=东|西|南|北|附近|境内|一带|别墅项目|项目|[。！？，、\s]|$)/u.exec(text);
  const destination=/(?:向|运往|送往|开往|寄到|导航到|前往)([\p{Script=Han}]{2,4}?)(?=捐赠|运送|配送|送货|救援|出发|发车|[。！？，、\s]|$)/u.exec(text);
  const district=/(?:整治后的|整顿后的|整治|整顿|位于|来自)([\p{Script=Han}]{2,4}?)(?=当地|假冒|市场|景区|制造业|工业园|产业园)/u.exec(text);
  const venue=namedHall ?? /(?:^|在|参观)([\p{Script=Han}]{1,4}?(?:厅|殿|阁|馆))(?=展示|陈列|再现|收藏|展出)/u.exec(text);
  const artifact=/^图为[\p{Script=Han}]{1,5}?(?:山|墓|馆)([\p{Script=Han}]{3,10}?(?:兽座|编钟|铜鼎|铜镜|金印|石碑))(?=[。，、\s]|$)/u.exec(text);
  const exhibit=collection ?? artifact;
  const institution=/(中国国家博物馆|国家博物馆|故宫博物院|[\p{Script=Han}]{2,6}?(?:省博物馆|市博物馆|博物院)|六艺城)/u.exec(text)?.[1];
  const exhibitContext=exhibit && (institution || artifact || /遗址|考古|汉墓|文物|青铜|博物馆/.test(text));
  const match=(exhibitContext && exhibit) || venue || feature || destination || district;
  if(!match) return null;
  const term=match[1], start=[...text.slice(0,match.index+match[0].lastIndexOf(term))].length;
  const observed=alternativesAt(text,start,start+[...term].length,readings);
  const known=(destination===match||district===match)?districtSpellings.get(sound(term)):null;
  if((destination===match||district===match) && !known?.has(term)) return null;
  const options=[...new Set([term,...observed,...(known??[])])].slice(0,4);
  const culture=match===exhibit || match===venue;
  const organization=(culture && institution) || /(?:图为|来自|^而?)([\p{Script=Han}]{2,4}?(?:红十字会|人民银行|博物馆))/u.exec(text)?.[1];
  const topics=[organization,...['红十字会','人民银行','救护车','捐赠','救援','口岸','航线','别墅','超稠油','油田','油藏','考古','文物','假冒','摩托车','展示','周游列国','兽座'].filter(t=>text.includes(t)),
    ...(venue?defaults.filter(n=>text.includes(n)):[]),
    ...(artifact && match===artifact?[match[0].slice(2,-term.length)]:[]),
    ...(culture?['奉先殿','青铜','西周','商代','汉墓','六艺城','宁乡','编钟','方尊','铜鼎','陶俑','漆器','书画','钟表'].filter(t=>text.includes(t)):[])].filter(Boolean);
  const independent=[...new Set(topics)].filter(t=>!topics.some(long=>long!==t && long.includes(t)));
  const other=feature && /^([\p{Script=Han}]{2,4}?)(?=超稠油|稠油|油田|煤田|矿区)/u.exec(text);
  return {term,options,topics:independent,start,known,organization,culture,utterance:text,companion:!culture && other?{term:other[1],start:0}:null};
}


function queries(transcript, fields) {
  if (privateLocation.test(transcript)) return [];
  const candidates = fields.filter(f=>['地名','用词'].includes(f.label))
    .flatMap(f=>f.options ?? []).filter(v=>geoTerm.test(v));
  const explicit = inSentence.exec(transcript)?.[1];
  if (explicit) candidates.unshift(explicit);
  for(const term of geographicWords) {
    if(transcript.includes(term) && !candidates.some(place=>place.includes(term))) candidates.push(term);
    if(candidates.length>=3) break;
  }
  return [...new Set(candidates)].filter(v=>!/[我你他她您]|公司|客户|员工|小区|一起|可能|决定/.test(v)).slice(0,2);
}

export async function placeEvidence(transcript, fields, search=publicPlaceSearch, names=queries(transcript,fields)) {
  if (!names.length) return [];
  const hits = await search(names.join(' ') + ' site:gov.cn', {limit:8,timeoutMs:3000});
  const seen = new Set();
  return hits.filter(hit=>{
    try {
      const url = new URL(hit.url);
      if (seen.has(url.href) || url.protocol !== 'https:' || !/\.gov\.cn$/i.test(url.hostname)) return false;
      seen.add(url.href);
      return names.some(n => {
        if (hit.title.includes(n)) return true;
        if (n.length<4) return false;
        for (let i=0;i<=hit.title.length-n.length;i++) {
          const candidate=hit.title.slice(i,i+n.length);
          if (candidate.startsWith(n.slice(0,2)) && candidate.endsWith(n.at(-1)) &&
              [...candidate].filter((ch,j)=>ch!==n[j]).length===1) return true;
        }
        return false;
      });
    } catch { return false; }
  }).slice(0,2).map(hit=>({title:hit.title,url:hit.url}));
}

const judgeScript=fileURLToPath(new URL('../scripts/voice_context_choice.py',import.meta.url));
function chooseInContext(text,fields,python) {
  const exe=python || process.env.PYTHON_PATH || path.join(process.env.LOCALAPPDATA ?? '', 'AstrBot/backend/python/python.exe');
  return new Promise((resolve,reject)=>{
    const child=execFile(exe,['-X','utf8',judgeScript],{windowsHide:true,timeout:45000,encoding:'utf8'},(error,stdout)=>{
      if(error) return reject(error);
      try {resolve(JSON.parse(stdout));} catch(err) {reject(err);}
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({text,fields}));
  });
}

export async function resolveVoiceVocabulary(names,key,transcript,fields,search=publicPlaceSearch,
    {python,judge=chooseInContext,readings=[],primary=[],confirmed=[],openArticle}={}) {
  const chars=[...transcript];
  const focusBefore=geographicFocus(transcript,readings);
  const extra=semanticFields(transcript,fields,readings).filter(f=>!focusBefore ||
    f.end<=focusBefore.start || f.start>=focusBefore.start+focusBefore.term.length);
  const disputed=[...fields,...extra].filter(f=>f.label==='用词' && chars.length>=8 && f.options.length>=2 && f.options.length<=4 &&
    f.options.every(t=>/^[\p{Script=Han}]{1,12}$/u.test(t)) && chars.slice(f.start,f.end).join('')===f.options[0]).sort((a,b)=>a.start-b.start);
  const contextEdits=[];
  let contextError=false;
  if(disputed.length) {
    try {
      const picks=await judge(transcript,disputed,python);
      for(let i=disputed.length-1;i>=0;i--) {
        const f=disputed[i], value=picks[i];
        if(!f.options.includes(value) || value===f.options[0]) continue;
        const original=f.options[0];
        const compact=s=>s.replace(/[\p{P}\s]/gu,'');
        const left=compact([...transcript].slice(0,f.start).join('')).slice(-2);
        const right=compact([...transcript].slice(f.end).join('')).slice(0,2);
        const supporting=primary.filter(line=>compact(line).includes(left+original+right)).length;
        if(supporting>=4 && supporting/primary.length>=0.8) continue;
        chars.splice(f.start,f.end-f.start,...value);
        contextEdits.push({heard:f.options[0],value});
      }
    } catch {contextError=true;}
  }
  const personResult=names.correct(key,chars.join(''),fields);
  let text=personResult.text;
  // The first, already confirmed locality can identify a homophonous neighbor.
  const neighbor=!privateLocation.test(text) && /与([\p{Script=Han}]{2,5}?(?:乡|县|镇|村))相邻的([\p{Script=Han}]{2,5}?(?:乡|县|镇|村))/u.exec(text);
  let neighborProof;
  if(neighbor && !confirmed.some(word=>word && neighbor[2].includes(word))) {
    neighborProof=await verifyAnchoredSpelling(neighbor[2],neighbor[1],'neighbor',search,openArticle);
    if(neighborProof && neighborProof.value!==neighbor[2]) {
      const start=neighbor.index+neighbor[0].length-neighbor[2].length;
      text=text.slice(0,start)+neighborProof.value+text.slice(start+neighbor[2].length);
    }
  }
  const focus=geographicFocus(text,readings);
  if(focus && focusBefore?.term===focus.term)
    focus.options=[...new Set([...focus.options,...focusBefore.options])].slice(0,4);
  const check=focus ? await verifyPublicName(focus,search,openArticle) : null;
  const terms=focus ? focus.options : queries(text,fields);
  const places=check ? check.places : await placeEvidence(text,fields,search,terms);
  const placeEdits=[];
  if(neighborProof && neighborProof.value!==neighbor[2]) placeEdits.push({heard:neighbor[2],value:neighborProof.value,sources:[neighborProof.source]});
  const geoQuestions=[];
  if(check && check.value!==focus.term) {
    const line=[...text];
    line.splice(focus.start,[...focus.term].length,...check.value);
    text=line.join('');
    placeEdits.push({heard:focus.term,value:check.value});
  } else if(check?.ambiguous && /请.{0,4}(?:寄|送|导航)|帮我(?:寄|送|导航)|导航到/.test(text)) {
    geoQuestions.push({start:focus.start,end:focus.start+focus.term.length,label:'地名',options:focus.options});
  }
  if(check?.companion && check.companion.value!==focus.companion.term) {
    const {term,start}=focus.companion;
    const chars=[...text];
    chars.splice(start,[...term].length,...check.companion.value);
    text=chars.join('');
    placeEdits.push({heard:term,value:check.companion.value,sources:check.companion.places});
  }
  for(const term of check ? [] : terms) {
    if(term.length<4 || !text.includes(term) || places.some(p=>p.title.includes(term))) continue;
    const alternatives=new Set();
    for(const {title} of places) for(let i=0;i<=title.length-term.length;i++) {
      const word=title.slice(i,i+term.length);
      if(word.startsWith(term.slice(0,2)) && word.endsWith(term.at(-1)) &&
         [...word].filter((c,j)=>c!==term[j]).length===1 && reading(word)===reading(term)) alternatives.add(word);
    }
    if(alternatives.size!==1) continue;
    const [value]=alternatives;
    text=text.replaceAll(term,value);
    placeEdits.push({heard:term,value});
  }
  const webSpan=focus?.culture && (check.verified || check.conflict)
    ? {start:focus.start,end:focus.start+[...focus.term].length} : undefined;
  const cultural=applyCulturalTerms(text,readings,webSpan);
  if(focus?.culture && check.verified && check.value!==focus.term) {
    cultural.edits.push({...webSpan,heard:focus.term,value:check.value,source:places[0].url});
  }
  return {text:cultural.text,culturalEdits:cultural.edits,contextEdits,contextError,nameEdits:personResult.edits,names:personResult.related,placeEdits,places,
    queries:terms,geoQuestions,focusedQuery:check?.query};
}
