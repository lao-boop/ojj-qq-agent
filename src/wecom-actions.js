// Ephemeral view of one group's archived sources. A new question rebuilds it from
// the originals, including later corrections, without writing model guesses to the archive.
export const actionGuide = '四个角色栏目齐全时用动作记录代替整组猜测，返回 {"actions":[["子项原名",[[动作名,状态,本子项消息序号,该消息中的逐字短句]]]]}。每组至少一行。动作名是稳定的简短指称，同一动作历次变化用同一名，不同动作分开。按时间给与当前判断相关的变更；纯补数不生成动作。owner=目前须老板行动，cancel=明确撤回给老板的这一项，self=经办员工明确接手，dependency=其他明确岗位先办，unknown=未明确下一步经办，ambiguous=后续变更无法指向具体动作。已经生效的取消不能当成新请示。员工承担后半程不抹掉前置岗位。转述者不等于执行者。不要为没有发生的旧计划建记录。每个状态各引用支持它的完整原话分句，包含否定词和动作，不截取反义短语；证据仅取原话，不取附带的引用副本。若不知是否撤回哪一项，标 ambiguous 并保留疑问。';
const states = new Set(['owner','cancel','self','dependency','unknown','ambiguous']);

export function readActions(rows, sources, actionText=text=>text) {
  if(!Array.isArray(rows) || !rows.length)throw Error('每组至少提供一项有原话的动作');
  const changes=rows.map((row,order)=>{
    if(!Array.isArray(row)||row.length!==4)throw Error('动作行须为四项');
    const [name,state,reference,cited]=row;
    const n=Number.isInteger(reference)?reference:sources.findIndex(m=>m.id===reference)+1;
    const source=sources[n-1];
    if(typeof name!=='string'||!name.trim()||!states.has(state)||!source)throw Error('动作、状态或组内来源编号不符');
    const text=source.text.split('\n[该消息引用')[0];
    const fragments=Array.isArray(cited)?cited:[cited];
    if(!fragments.length)throw Error('动作缺少引文');
    let start=-1,end=0;
    for(const fragment of fragments){
      if(typeof fragment!=='string'||fragment.trim().length<2)throw Error('动作引文为空或过短');
      const position=text.indexOf(fragment,end);
      if(position<0)throw Error('动作引文须逐字出现在该组指定消息里');
      if(start<0)start=position;
      end=position+fragment.length;
    }
    return {name:name.trim(),state,source,quote:text.slice(start,end),seq:n,order};
  }).filter(e=>actionText(e.quote).trim()).sort((a,b)=>a.seq-b.seq||a.order-b.order);
  if(!changes.length){
    const source=sources.at(-1);
    changes.push({name:'分工',state:'unknown',source,quote:source.text.split('\n[该消息引用')[0],seq:sources.length,order:0});
  }
  const current=new Map(), withdrawals=new Map();
  for(const change of changes){
    const prior=current.get(change.name);
    if(change.state==='cancel')withdrawals.set(change.name,change);
    if(change.state==='owner')withdrawals.delete(change.name);
    // A retraction removes a request, but does not establish who took over.
    if(change.state==='cancel' && prior?.state==='self' && prior.seq===change.seq)continue;
    current.set(change.name,change);
  }
  const entries=[...current.values()];
  const disputed=entries.some(e=>e.state==='ambiguous');
  const pending=entries.filter(e=>e.state==='owner');
  const role=pending.length?'owner':disputed?'unknown':
    entries.some(e=>e.state==='dependency')?'dependency':
    entries.some(e=>e.state==='unknown')?'unknown':entries.some(e=>e.state==='self')?'self':'unknown';
  const status=pending.length?(withdrawals.size?'partial':'active'):disputed?'unclear':(withdrawals.size?'withdrawn':'none');
  const evidence=entries.findLast(e=>e.state===role || role==='unknown' && e.state==='ambiguous')||entries.at(-1);
  return {role,status,evidence,entries,withdrawals:[...withdrawals.values()]};
}

export function describeActions(group,label,ledger) {
  const disposition={
    partial:'已有请示撤回，您仍有待办。',active:'目前有需要您处理的事项。',
    withdrawn:'已撤回对您的相应请示。',none:'未发现给您的当前待办。',
    unclear:'变更指向还不明确，老板待办状态待核实。'
  };
  const phrases={owner:'待您处理',cancel:'已撤回请示',self:'员工接手',dependency:'须等前置岗位',unknown:'经办未定',ambiguous:'变更指向未明'};
  const evidence=[...new Set([...ledger.withdrawals,...ledger.entries])].sort((a,b)=>a.seq-b.seq || a.order-b.order);
  // A selected clause may only say “I will do it after that”. Supply its actual
  // parent utterance so the reader can see who must act first, and any exceptions.
  const cited=[...(ledger.origins||[]),...evidence];
  const context=new Map();
  for(const entry of cited){
    const original=entry.source.text.split('\n[该消息引用')[0].trim();
    if(original!==entry.quote)context.set(entry.source.id,{speaker:entry.source.speaker,original});
  }
  const sequence=(ledger.sequence||[]).map(({first,next})=>
    '办理顺序，先按'+first.speaker+'的原话“'+first.text+'”，随后按'+next.speaker+'的原话“'+next.text+'”。');
  const full=[...context.values()].map(x=>'同条上下文，'+x.speaker+'的原话是“'+x.original+'”。');
  return group+'当前的分工类别是'+label+'。'+disposition[ledger.status]+'\n'+
    (ledger.origins||[]).map(e=>'较早提及，'+e.source.speaker+'的原话是“'+e.quote+'”。\n').join('')+
    evidence.map(e=>phrases[e.state]+'，'+e.source.speaker+'的原话是“'+e.quote+'”。').concat(sequence,full).join('\n');
}

// Expose addressable clauses, so two obligations mentioned by the same person in
// the same message can have different identities. The full archive stays intact.
export function actionSources(sources, actionText) {
  const pieces=[];
  for(const [i,source] of sources.entries()){
    const body=actionText(source.text);
    for(const [j,part] of body.split(/[，,；;。！？]/u).entries()){
      const text=part.trim();
      if(text)pieces.push({ref:source.id+'.'+(j+1),speaker:source.speaker,text,index:i});
    }
  }
  return pieces;
}

export const taskGuide='你是员工向同一位老板汇报的内部秘书。各组独立核对哪些具体委托还有效，按顺序读该组发言。提供的是去掉纯记账句后的逐字原话，ref 是本组内的证据地址。返回 JSON 对象 {"groups":[{"name":"组原名","tasks":[{"anchor":"首次提到该动作的ref","state":"owner","basis":"直接说明当前状态的ref","withdrawal":null}]}]}。每个具体动作只给一项最终状态，anchor 是原文地址，不取自己起的名字。state 只选 owner=现在仍要老板办、self=员工已接手、dependency=要等具体内部岗位、unknown=没有确定谁办、cancel=明确撤回给老板的请求且没人接手、ambiguous=变更指向无法确定。withdrawal 填明确撤回该动作给老板的请示的ref，其他情况为null。员工自办前曾撤回该项请示时，state=self、basis用接手原句、withdrawal用撤回原句；如果另一项仍在等老板，另列owner。重新请示后该项只列当前owner、withdrawal为null。员工说先做准备并不等于可以跳过确认。只转述不代表接手。前面提到的疑问或过时分工不要另算成待办。有明确前置与后续时分别列出dependency和self，在后续项的after字段填前置项的basis。即使员工已做准备，也要核对最新分工句。原文没说先后的独立动作不要相连。经办未定也应列unknown。如分句缺少判断所需的整句或回复背景，可为该组返回reread:true以调取原话。只用本组提供的真实ref，禁止生成引文、解释或数字累计。';

export function taskSnapshot(tasks,pieces,sources) {
  if(!Array.isArray(tasks)||!tasks.length)throw Error('每组需要给出当前动作');
  const refs=new Map(pieces.map(p=>[p.ref,p]));
  const snapshots=new Map(),events=[];
  const resolve=ref=>{
    const piece=refs.get(String(ref));
    if(!piece)throw Error('证据地址在本组原话里不存在：'+ref);
    return piece;
  };
  for(const task of tasks){
    const anchor=resolve(task.anchor),basis=resolve(task.basis);
    if(!states.has(task.state))throw Error('动作状态不符');
    // A single opening sentence may request two decisions. Each distinct current
    // basis identifies its own task, even when both share the same original request.
    const key=anchor.ref+'/'+basis.ref;
    const fingerprint=JSON.stringify([task.state,task.withdrawal??null,task.after??null]);
    if(snapshots.has(key)){
      if(snapshots.get(key)!==fingerprint)throw Error('同一项当前依据给出了冲突状态');
      continue;
    }
    snapshots.set(key,fingerprint);
    let state=task.state;
    if(state==='self' && /撤回|收回|取消|作废|不必您|不用您|无需您/u.test(basis.text) &&
       !/我(?:接手|负责|自己|自行|亲自|来办|来排)|由我/u.test(basis.text))state='cancel';
    if(anchor.index>basis.index)throw Error('当前判断早于动作首次出现');

    if(task.withdrawal!=null){
      const cancel=resolve(task.withdrawal);
      if(task.state==='owner'||cancel.index>basis.index||cancel.index<anchor.index)throw Error('请核对同一项撤回和再请示的先后');
      events.push([key,'cancel',cancel.index+1,cancel.text]);
    }
    events.push([key,state,basis.index+1,basis.text]);
  }
  const ledger=readActions(events,sources);
  const prerequisites=new Set(tasks.filter(task=>task.state==='dependency').map(task=>task.basis));
  ledger.sequence=[];
  for(const task of tasks){
    if(task.after==null)continue;
    if(task.state!=='self'||task.after===task.basis||!prerequisites.has(task.after)){
      throw Error('后续动作须引用本组另一项仍有效的前置动作依据');
    }
    ledger.sequence.push({first:resolve(task.after),next:resolve(task.basis)});
  }
  ledger.origins=tasks.flatMap(task=>{
    const origin=resolve(task.anchor);
    if(task.anchor===task.basis||task.anchor===task.withdrawal)return [];
    return [{source:sources[origin.index],quote:origin.text}];
  });
  return ledger;
}
