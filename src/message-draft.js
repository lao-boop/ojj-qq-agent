/** Detect requests to author a message before the relay parser can split its instructions. */
export function isMessageDraft(input) {
  const text = String(input || '').trim();
  const head = text.split(/[：:\n]/u, 1)[0];
  // In a direct relay, writing instructions after the addressee belong to the recipient.
  // An explicitly supplied verbatim draft is already handled by readRelayEnvelope.
  if (/^(?:只起草|先给我看草稿)[\s\S]*?(?:拟发给|暂缓发给)[^：:]+[：:]/.test(text)) return false;
  if (/^(?:请|帮我|麻烦)?(?:告诉|发给|通知|转告|转给|传给)/.test(text)) return false;
  if (/(?:写好|改好|拟好|起草好|润色好)(?:后|了)?(?:就|再|直接)?(?:发给|发送|通知|转告)/.test(head)) return false;
  if (/(?:文档|报告|合同|论文|计划书|PPT|Word|Excel)/i.test(head) && !/(?:消息|问询|通知|怎么说)/.test(head)) return false;
  return /^(?:(?:请|麻烦|帮忙|帮我|给我|替我|先|只|这次)\s*)*(?:起草|拟稿|只要成稿|要成稿|拟(?:一条|一句|一段|一版)|写(?:一条|一句|一段))/.test(head) ||
    /(?:怎么说(?:才|更)?合适|怎样措辞|给我可复制的版本)/.test(head);
}

/** The writer receives no messaging tools. Only the boss sees its text. */
export async function composeMessageDraft(text, llm) {
  const prompt = [
    {role:'system',content:'替用户写一条可以直接复制给收件人的中文工作消息。根据整段请求写，只返回成稿，不加前言、占位符、发送回执或备选项。按原文保留订单号、金额、数量、否定、条件和回复期限。用户想向对方询问的未知信息直接在消息中询问，不要反问用户或捏造答案。没有指定称呼时直接用“您好”。如果用户只要求起草却完全没给主题或正文，才简短询问要写什么。'},
    {role:'user',content:text}
  ];
  const numbers = [...String(text).matchAll(/\d+(?:[.:：-]\d+)*/g)].map(m=>m[0].replaceAll('：',':'));
  const normalized = s => s.replaceAll('：',':').replace(/\s/g,'');
  for (let attempt=0;attempt<2;attempt++) {
    const answer=await llm.chat({messages:prompt,directAnswer:true,temperature:0.2,maxTokens:700});
    const draft=String(answer.content||'').trim();
    const actualNumbers=normalized(draft).match(/\d+(?:[.:-]\d+)*/g)||[];
    const complete=numbers.every(n=>actualNumbers.includes(n) || actualNumbers.includes(n+':00'));
    if(draft && complete && !/【[Xx待].*?】|\[待填|X月X日/.test(draft))return draft;
    prompt.push({role:'assistant',content:draft},{role:'user',content:'请重新写完整成稿。逐项核对原文中的数字、订单和回复期限，保留原来的数字写法，不使用占位符。'});
  }
  throw new Error('成稿未通过完整性检查');
}
