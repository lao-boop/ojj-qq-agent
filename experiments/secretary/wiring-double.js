// Deliberately no language understanding. Only exercises schemas and transport.
export function wiringResponse(options, text) {
  const input = JSON.parse(options.messages[1].content);
  const rows = input.messages.filter(m => !m.contextOnly);
  if (input.stage === 'evidence') return { content: JSON.stringify({importance:'substantive',items:Array.from({length:Math.ceil(rows.length/12)},(_,group)=>({
    id:`I${group}`,topic:'测试通路',priority:'normal',reason:'仅检查接线，不评估内容',updates:[],
    facts: rows.slice(group*12,group*12+12).map((r,i) => ({id:`F${group}-${i}`,text:r.text.slice(0,100),status:'reported',evidence:[{source:r.id,quote:r.text.slice(0,100)}]})),
  }))}) };
  const prose = text || rows.map(m => m.text.slice(0,25)).join('；').slice(0,210);
  return { content: JSON.stringify({importance:'substantive',paragraphs:[input.stage === 'compose'
    ? {text:prose,facts:input.plan.items.flatMap(i => i.facts.filter(f=>f.status!=='superseded').map(f=>f.id))}
    : {kind:'fact',text:prose,sources:rows.map(r=>r.id)}]}) };
}
