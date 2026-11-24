import {Converter} from 'opencc-js';
import fs from 'node:fs';
import {sound} from './voice-review.js';
import {publicPlaceSearch} from './websearch.js';

const simplified=Converter({from:'tw',to:'cn'});
const curated=JSON.parse(fs.readFileSync(new URL('../data/voice-public-sources.json',import.meta.url),'utf8'));
const recent=new Map();
const publishers=/(?:^|\.)(?:gov\.cn|edu\.cn|gov\.mo|gov\.hk|redcross\.org\.mo|redcross\.org\.cn|cnpc\.com\.cn|xinhuanet\.com|news\.cn|chinanews\.com(?:\.cn)?|people\.com\.cn|cctv\.com|cntv\.cn|yicai\.com|ts\.cn|zjol\.com\.cn|chnmuseum\.cn|dpm\.org\.cn)$/i;
function publisherUrl(raw) {
  try {
    const u=new URL(raw);
    const newsroom=['news.sina.com.cn','news.sohu.com'].includes(u.hostname);
    const culturalPublisher=/(?:^|\.)(?:cas\.cn|shandong-chorography\.org|njmuseum\.com)$/i.test(u.hostname);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||!(publishers.test(u.hostname)||newsroom||culturalPublisher)) return null;
    u.protocol='https:';
    return u.href;
  }catch{return null;}
}

async function article(url) {
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(3500)});
  const reader=r.body?.getReader();
  if(!reader) return '';
  const chunks=[];
  try {
    if(!r.ok || !/text\/html|application\/xhtml/.test(r.headers.get('content-type')??'')) return '';
    let total=0;
    while(total<650000) {
      const {value,done}=await reader.read();
      if(done) break;
      chunks.push(Buffer.from(value)); total+=value.length;
    }
  } finally {await reader.cancel().catch(()=>{});}
  const bytes=Buffer.concat(chunks);
  const enc=(r.headers.get('content-type')+' '+bytes.subarray(0,3500).toString('latin1')).match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i)?.[1]??'utf-8';
  const html=new TextDecoder(enc).decode(bytes).replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  const text=html.replace(/<[^>]*>/g,' ').replace(/&[a-z0-9#]+;/gi,' ').replace(/\s+/g,' ').slice(0,85000);
  const labels=[];
  if(url==='https://www.dpm.org.cn/pavilions.html') {
    for(const a of html.matchAll(/<a\b[^>]*>/gi)) {
      const name=a[0].match(/\btitle=["']([\p{Script=Han}]{2,12}(?:馆|厅))["']/u)?.[1];
      if(name) labels.push(name);
    }
  }
  return {text,labels};
}

const tones=new Map();
function pronunciation(ch) {
  if(!tones.has(ch)) tones.set(ch,sound(ch));
  return tones.get(ch);
}
function phoneticMatches(passage,options,allReadings) {
  const names=new Set(), term=options[0];
  const readings=allReadings?options.filter(o=>o.length===term.length):[term];
  for(const w of options) if(passage.includes(w)) names.add(w);
  for(const run of passage.match(/[\p{Script=Han}]+/gu)??[]) {
    for(let i=0;i<=run.length-term.length;i++) {
      const word=run.slice(i,i+term.length);
      if(readings.some(heard=>(word.at(-1)===heard.at(-1) || word[0]===heard[0]) &&
          [...word].every((ch,j)=>ch===heard[j]||pronunciation(ch)===pronunciation(heard[j])))) names.add(word);
    }
  }
  return names;
}

// Verify a spelling in the neighborhood of the event, not just somewhere on a matching page.
function matches(docs,options,topics,organization,culture=false) {
  const votes=new Map();
  for(const doc of docs) {
    if(culture && organization==='故宫博物院' && doc.url==='https://www.dpm.org.cn/pavilions.html') {
      for(const label of doc.labels??[]) {
        if(!options.some(option=>sound(option)===sound(label))) continue;
        const supporters=votes.get(label)??new Map();
        supporters.set(doc.url,{title:'故宫博物院 · 专馆',url:doc.url,excerpt:label});
        votes.set(label,supporters);
      }
    }
    for(const clue of topics) {
      for(const match of doc.text.matchAll(new RegExp(clue,'gu'))) {
        const passage=doc.text.slice(Math.max(0,match.index-110),match.index+110);
        if(organization && !culture) {
          const parts=organization.match(/^(.+?)(红十字会|人民银行|博物馆)$/u);
          if(parts && !(passage.includes(parts[1]) && passage.includes(parts[2]))) continue;
        }
        const nativeCatalog=culture && organization && (
          (organization.includes('国家博物馆') && new URL(doc.url).hostname.endsWith('.chnmuseum.cn')) ||
          (organization==='故宫博物院' && new URL(doc.url).hostname.endsWith('.dpm.org.cn')));
        if(culture && organization && !nativeCatalog && !passage.includes(organization)) continue;
        const n=topics.filter(t=>passage.includes(t) || (nativeCatalog && t===organization)).length;
        if(n<2) continue;
        for(const name of phoneticMatches(passage,options,culture)) {
          const supporters=votes.get(name)??new Map();
          supporters.set(doc.url,{title:doc.title,url:doc.url,excerpt:passage});
          votes.set(name,supporters);
        }
      }
    }
  }
  if(votes.size!==1) return {conflict:votes.size>1};
  const [[value,sources]]=votes;
  return {value,places:[...sources.values()].slice(0,3)};
}

// Only public place names or a short, recognizable quotation fragment enter the search.
export async function verifyAnchoredSpelling(heard,anchor,kind,search=publicPlaceSearch,open=search===publicPlaceSearch?article:null) {
  if(!/^[\p{Script=Han}]{2,12}$/u.test(heard)||!/^[\p{Script=Han}]{3,12}$/u.test(anchor)||!open)return null;
  const query=kind==='neighbor'?anchor+' 周边乡镇 site:gov.cn':anchor+' 诗词 原文';
  const hits=await search(query,{limit:6,timeoutMs:3000}).catch(()=>[]);
  const links=[...new Set(hits.map(h=>publisherUrl(h.url)).filter(Boolean))].slice(0,4);
  const docs=await Promise.all(links.map(async url=>{
    try{const b=await open(url);return {url,text:simplified(typeof b==='string'?b:b?.text??'')};}catch{return {url,text:''};}
  }));
  const seen=new Map();
  for(const {url,text} of docs) for(const m of text.matchAll(new RegExp(anchor,'gu'))){
    const left=text.slice(Math.max(0,m.index-90),m.index),right=text.slice(m.index+anchor.length,m.index+anchor.length+90);
    if(kind==='neighbor'){
      for(const span of [left,right]) for(const value of phoneticMatches(span,[heard],false)){
        if(value.at(-1)===heard.at(-1))seen.set(value,url);
      }
    }else{
      const candidate=kind==='quote-before'?left.replace(/[\p{P}\s]+$/gu,'').slice(-heard.length):right.replace(/^[\p{P}\s]+/gu,'').slice(0,heard.length);
      if(/^[\p{Script=Han}]+$/u.test(candidate)&&sound(candidate)===sound(heard))seen.set(candidate,url);
    }
  }
  if(seen.size!==1)return null;
  const [[value,url]]=seen;
  return {value,source:{url,title:anchor}};
}

export async function verifyPublicName(focus,search=publicPlaceSearch,open=search===publicPlaceSearch?article:null) {
  const {term,options,topics}=focus;
  const context=topics.join(' ');
  const key=JSON.stringify([term,options,topics,focus.companion?.term,focus.utterance]);
  const live=search===publicPlaceSearch && open===article;
  const saved=live && recent.get(key);
  if(saved && Date.now()-saved.at<600000) return saved.result;
  let domain='gov.cn';
  if(focus.organization?.includes('国家博物馆')) domain='chnmuseum.cn';
  else if(focus.organization==='故宫博物院') domain='dpm.org.cn';
  else if(topics.some(t=>/油田|油藏|稠油/.test(t))) domain='cnpc.com.cn';
  else if(topics.some(t=>/人民银行|证券|金融/.test(t))) domain='yicai.com';
  const queries=[...new Set([...(topics.length>=2?[context,context+' site:'+domain]:[]),
    ...options.slice(0,3).map(w=>[w,context].filter(Boolean).join(' '))])];
  const pages=await Promise.allSettled(queries.map(q=>search(q,{limit:7,timeoutMs:3500})));
  const links=new Map();
  // Curated entries locate publications, never supply spellings. Fetch and
  // evaluate their content under the same rules as dynamically discovered pages.
  if(live) for(const item of curated) {
    const url=publisherUrl(item.url);
    if(url && item.topics.every(t=>context.includes(t))) links.set(url,{url,title:'',curated:true});
  }
  // Interleave result lists so one query cannot consume the whole fetch budget.
  for(let i=0;i<8;i++) for(const page of pages) {
    const hit=page.status==='fulfilled'?page.value[i]:null, url=publisherUrl(hit?.url);
    if(url && !links.has(url)) links.set(url,{...hit,url});
  }
  const docs=await Promise.all([...links.values()].slice(0,6).map(async hit=>{
    let body='';
    try{if(open) body=await open(hit.url);}catch{/* Fall back to the attributed headline only. */}
    const content=typeof body==='string'?body:body?.text??'';
    const text=simplified(focus.culture?content:[hit.title,content].filter(Boolean).join(' '));
    return {title:hit.title || new URL(hit.url).hostname,url:hit.url,text,labels:body?.labels};
  }));
  const found=matches(docs,options,topics,focus.organization,focus.culture);
  const places=found.places??(focus.culture?[]:docs.filter(d=>options.some(o=>d.text.includes(o))).slice(0,3)
    .map(({title,url})=>({title,url})));
  const companion=focus.companion && matches(docs,[focus.companion.term],topics,focus.organization);
  const result={query:queries.join(' ｜ '),value:found?.value??term,places,
    verified:!!found.value,conflict:!!found.conflict,companion:companion?.value?companion:null,
    ambiguous:!!focus.known&&options.length>1&&!found.value};
  if(live && (found.value || result.companion)) {
    if(recent.size>=128) recent.delete(recent.keys().next().value);
    recent.set(key,{at:Date.now(),result});
  }
  return result;
}
