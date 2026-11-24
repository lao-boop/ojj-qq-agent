const action = '(?:告诉|转告|通知|发给|转给|传给|让)';
const pronoun = '(?:他|她|对方|刚才那位|刚提到的负责人|刚才的负责人|那位负责人)';
const name = '([\\p{Script=Han}A-Za-z0-9_.-]{1,32}?)';
const addressed = new RegExp('^(?:请|麻烦|帮我|请帮我)?(?:'+action+name+'|给'+name+'(?:发消息|说一声|说|带句话)|'+name+'收到)(?:[：:，,\\s]+|(?=[“「])|(?=今天|明天|周[一二三四五六日]|订单|批次))([\\s\\S]+)$','u');
const splitPoint = new RegExp('(?:[。！？；;，,]\\s*(?:(?:另外|然后|同时|再)[，,]?\\s*)?|\\s+(?:再|同时))(?=(?:请)?(?:'+action+'|给)|[\\p{Script=Han}]{1,12}收到[“「])','gu');
const noDispatch = /起草|草稿|先别发|不要发|暂缓发|别发|先不发|只写|帮我写|等我审核|取消发送/;
const orderPattern = /(?:订单|工单|批次)\s*[A-Z]*[-#]?\d[\w-]*/gi;
const unquote = text => text.trim().replace(/^[“「]([\s\S]*)[”」][。.]?$/,'$1');

function splitRequests(text) {
  // Ignore separators inside quoted message bodies.
  const start = text.replace(/^(?:请)?(?:分别传话|两条分别转达|分别转告|分别通知)[。：:，,\s]*/, '');
  const masked = start.replace(/“[^”]*”|「[^」]*」|"[^"]*"/g,s=>s[0]+'□'.repeat(s.length-2)+s.at(-1));
  const chunks=[];
  let from=0;
  for(const match of masked.matchAll(splitPoint)){
    const end=match.index;
    chunks.push(start.slice(from,end)+(match[0].startsWith('。')?'。':''));
    from=end+match[0].length;
  }
  chunks.push(start.slice(from));
  return chunks;
}

function clause(text,users) {
  const raw=text.trim();
  // In spoken messages the recipient and the task often have no punctuation between them.
  const spoken=new RegExp('^(?:请|麻烦|帮我)?'+action+'(.+)$','u').exec(raw);
  if(spoken){
    const target=users.filter(u=>spoken[1].startsWith(u.name)).sort((a,b)=>b.name.length-a.name.length)[0];
    if(target){
      const body=spoken[1].slice(target.name.length).replace(/^[：:，,\s]+/,'');
      if(body && !/^(?:和|与|及|、|或|还是)/.test(body))
        return {query:target.name,candidates:users.filter(u=>u.name===target.name),body:unquote(body)};
    }
  }
  if(spoken){
    const nickname=/^([小老][\p{Script=Han}])([\p{Script=Han}].*)$/u.exec(spoken[1]);
    if(nickname){
      const candidates=users.filter(u=>u.name.includes(nickname[1]));
      if(candidates.length>1)return {query:nickname[1],candidates,body:nickname[2]};
    }
  }
  const m=addressed.exec(raw);
  if(!m)return null;
  const query=m[1]||m[2]||m[3];
  const exact=users.filter(u=>u.name===query||u.userid===query);
  const candidates=exact.length?exact:users.filter(u=>u.name.includes(query));
  return {query,candidates,body:unquote(m[4])};
}

export class BossRelayConversation {
  constructor(){this.chats=new Map();}
  prepare(key,input,users,now=Date.now()){
    const text=String(input||'').trim();
    const entry=this.chats.get(key);
    const state=entry&&now-entry.at<15*60*1000?entry:{};
    this.chats.delete(key);
    const keep=()=>{state.at=now;this.chats.set(key,state);};
    const finish=parts=>{
      const missing=parts.find(p=>!p.candidates.length);
      if(missing)return {reply:'没有找到「'+missing.query+'」，请提供通讯录中的完整姓名。'};
      const ambiguous=parts.find(p=>p.candidates.length>1);
      if(ambiguous){
        state.parts=parts;keep();
        return {reply:'「'+ambiguous.query+'」指哪位？'+ambiguous.candidates.map((u,i)=>(i+1)+'．'+u.name+'（'+u.userid+'）').join('、')};
      }
      if(parts.some(p=>!users.some(u=>u.userid===p.candidates[0].userid)))return {reply:'联系人已变更，请重新确认收件人。'};
      delete state.parts;
      return {items:parts.map(p=>({target:p.candidates[0],text:p.body}))};
    };
    if(state.parts){
      if(/^(?:取消|算了|不发了|停止)[。！!\s]*$/.test(text))return {reply:'已取消，没有发送。'};
      const part=state.parts.find(p=>p.candidates.length>1);
      const selection=text.replace(/[。！!]+$/,'');
      const descriptor=selection.replace(/^(?:就是|是|选|发给)/,'').replace(/(?:的那位|那一位|那位|那个|那边的)$/,'');
      const number=/^(?:第)?([1-9]|一|二|三|四|五)(?:个|位)?$/.exec(selection);
      const index=number?(Number(number[1])||'一二三四五'.indexOf(number[1])+1)-1:-1;
      const possible=part.candidates.filter((u,i)=>number?i===index:
        selection===u.userid || selection===u.name || (descriptor.length>0 && u.name.includes(descriptor)) ||

        (selection.endsWith('那位，发给'+u.name) || selection==='是'+u.name || selection===u.name+'那位'));
      if(possible.length===1){
        // Recheck the directory before sending a previously held message.
        const user=users.find(u=>u.userid===possible[0].userid);
        if(!user)return {reply:'这位联系人已不在通讯录，请重新指定。'};
        part.candidates=[user];
        return finish(state.parts);
      }
      // A new instruction supersedes the pending one. Other answers repeat the question.
      if(!clause(text,users))return finish(state.parts);
      delete state.parts;
    }
    const orders=[...new Set(text.match(orderPattern)||[])];
    const names=users.filter(u=>text.includes(u.name));
    if(orders.length===1 && names.length===1 && /负责|经办人|手里的|跟进|对接|名下|的订单|的工单/.test(text) &&
        !/[？?]|并非|不再|不是|不由|暂未|请问|告诉|通知|发给|转告|传给|提醒|起草|帮我|带句话|转给|发消息/.test(text)){
      state.topic={user:names[0],order:orders[0]};
      keep();
      return {reply:'记下了，'+orders[0]+'由'+names[0].name+'负责。'};
    }
    const ref=new RegExp('^(?:请)?(?:'+action+pronoun+'|给'+pronoun+'发消息|把这单的新数量转告'+pronoun+')[：:，,\\s]*([\\s\\S]+)$').exec(text);
    if(ref && !noDispatch.test(text)){
      if(!state.topic)return {reply:'请确认联系人和对应的订单。'};
      const {user,order}=state.topic;
      if(!users.some(u=>u.userid===user.userid))return {reply:'请确认这位联系人的当前姓名。'};
      const body=ref[1].trim();
      keep();
      return {items:[{target:user,text:(orders.length?'':order+'，')+(/^把这单的新数量/.test(text)?'新数量为':'')+body}]};
    }
    const chunks=splitRequests(text);
    const parts=chunks.map(t=>clause(t,users));
    if(parts.length>1 && parts[0]){
      if(noDispatch.test(text) && /(?:^|[。；，,！])\s*(?:只起草|先别发|不要发送|等我审核|暂缓发送)/.test(text))return {reply:'请确认哪些内容现在要发，哪些只起草。'};
      if(parts.some(p=>!p))return {reply:'请分别确认每位收件人的姓名和对应内容。'};
      return finish(parts);
    }
    if(parts.length===1 && parts[0]?.candidates.length>1)return finish(parts);
    return null;
  }
}
