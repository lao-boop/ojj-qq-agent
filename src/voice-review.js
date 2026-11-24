import {pinyin} from 'pinyin-pro';

const words = new Intl.Segmenter('zh',{granularity:'word'});
const han = /^[\p{Script=Han}]+$/u;
const compact = s=>s.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'');
export const sound = value=>pinyin(value,{type:'array',toneType:'num'}).join('/');

// Align using both neighboring fragments. Repeated anchors cannot authorize an edit.
export function alternativesAt(text,start,end,readings) {
  const chars=[...text], word=chars.slice(start,end).join('');
  const left=compact(chars.slice(0,start).join('')).slice(-3);
  const right=compact(chars.slice(end).join('')).slice(0,3);
  if(left.length+right.length<3 || !han.test(word)) return [];
  const observed=new Set();
  for(const hypothesis of readings) {
    const line=compact(hypothesis);
    let at=left ? line.indexOf(left) : 0;
    if(at<0 || (left && line.indexOf(left,at+1)>=0)) continue;
    at+=left.length;
    const candidate=line.slice(at,at+word.length);
    if(candidate===word || candidate.length!==word.length || !han.test(candidate)) continue;
    if(right ? !line.startsWith(right,at+word.length) : at+word.length!==line.length) continue;
    observed.add(candidate);
  }
  return [...observed];
}

export function semanticFields(text,existing,readings) {
  if(!readings.length) return [];
  const extra=[];
  let start=0;
  for(const {segment:word} of words.segment(text)) {
    const end=start+[...word].length;
    if(han.test(word) && word.length<=5 && !/[零〇一二三四五六七八九十百千万亿他她它]/.test(word) &&
       !existing.some(f=>f.start<end && start<f.end)) {
      const options=alternativesAt(text,start,end,readings).filter(v=>sound(v)===sound(word));
      if(options.length && options.length<=2) {
        let from=start, to=end;
        if(word.length===1) {
          const chars=[...text];
          chars[start]=options[0];
          const variant=chars.join('');
          const token=words.segment(variant).containing(chars.slice(0,start).join('').length);
          if(token && han.test(token.segment) && token.segment.length<=4) {
            from=[...variant.slice(0,token.index)].length;
            to=from+[...token.segment].length;
          }
        }
        if(![...existing,...extra].some(f=>f.start<to && from<f.end)) {
          const chars=[...text], left=chars.slice(from,start).join(''), right=chars.slice(end,to).join('');
          extra.push({start:from,end:to,label:'用词',crossCheck:true,options:[word,...options].map(v=>left+v+right)});
        }
      }
    }
    start=end;
  }
  return extra.slice(0,3);
}
