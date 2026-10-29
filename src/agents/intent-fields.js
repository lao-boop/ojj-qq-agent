/** Recover only an explicitly written document label, never a topic invented from attachment data. */
export function completeExplicitTopic(intent, instruction) {
  if (intent.kind !== 'general' || !intent.operations.includes('document.create') || intent.slots.topic?.trim()) return intent;
  const text = String(instruction || '');
  // Ambiguous corrections must go back through semantic understanding, not this narrow fallback.
  if (/(不要|别|不是).{0,12}(excel|word|ppt|表格|文档)/i.test(text)) return intent;
  if (/或者|还是|或/.test(text)) return intent;
  const candidates = new Set();
  for (const m of text.matchAll(/(?:主题|题目|标题)\s*(?:是|为|[:：])\s*[《「“"]?([^，。；！？\n》」”"]{2,60})/g)) candidates.add(m[1].trim());
  if (!candidates.size) for (const m of text.matchAll(/(?:excel|word|ppt|xlsx|docx)\s*(?:的)?([\p{L}\p{N}]{1,32}?(?:表|报告|清单|计划|周报|总结))/giu)) candidates.add(m[1]);
  const valid = [...candidates].filter(t => t.length >= 2 && !['表格', '文档', '文件', '一个表', '一份表', '电子表'].includes(t));
  if (valid.length !== 1) return intent;
  return { ...intent, slots: { ...intent.slots, topic: valid[0] }, missing: intent.missing.filter(k => !['topic', '主题', '文档主题', '表名'].includes(k)) };
}

/** Repair field placement/terminal punctuation, not the model's choice of operation. */
export function completeExplicitFields(intent, instruction) {
  let completed = completeExplicitTopic(intent, instruction);
  if (completed.kind !== 'general') return completed;
  const text = String(instruction || '').trim();
  const ops = completed.operations;
  if (ops.some(op => ['memory.write','memory.publish','speech.synthesize'].includes(op)) &&
      !ops.includes('document.create') && !completed.slots.text && completed.slots.dataText?.trim() && text.includes(completed.slots.dataText)) {
    completed = { ...completed, slots: { ...completed.slots, text: completed.slots.dataText }, missing: completed.missing.filter(k => !['text','正文','朗读原文','记忆正文'].includes(k)) };
  }
  const lookups = ops.filter(op => ['research.search', 'automotive.identify'].includes(op));
  const topic = completed.slots.topic?.trim();
  // A topic is not automatically a query: it may belong to an unrelated document.
  // Only accept it as the exact operand of one positive lookup clause in the instruction.
  if (lookups.length === 1 && !completed.slots.query?.trim() && topic &&
      !completed.forbiddenOperations.includes(lookups[0]) &&
      !/(?:不要|别|不用|不必|不需要|不是|取消)[^，。；！？\n]{0,12}(?:查|搜|检索)/.test(text) &&
      !/或者|还是|或/.test(text)) {
    const queries = text.split(/[，。；！？\n]/).map(clause =>
      /^(?:(?:请|帮我|先|再|然后)\s*)*(?:搜索|查询|检索|查找|查一下|搜一下)\s*(?:一下)?\s*(?:关于)?\s*(.+)$/.exec(clause.trim())?.[1]?.trim()
    ).filter(Boolean);
    if (queries.length === 1 && queries[0] === topic) completed = {
      ...completed,
      slots: { ...completed.slots, query: topic },
      missing: completed.missing.filter(k => !['query', '查询词', '查询内容'].includes(k)),
    };
  }
  // Recover a literal only when the recognized words already match. This does not
  // turn paraphrases, attachment text, or trailing instructions into authorized speech.
  if (ops.includes('speech.synthesize') && !completed.forbiddenOperations.includes('speech.synthesize') &&
      !ops.some(op => ['memory.write', 'memory.publish'].includes(op))) {
    const match = /^(?:请\s*)?(?:用语音(?:把这句话)?(?:读出来|朗读|读)|把这句话读出来|朗读)\s*[:：]\s*([\s\S]+)$/.exec(text);
    if (match) {
      const literal = unquote(match[1].trim());
      const terminalKey = value => String(value || '').trim().replace(/[。.!！?？…]+$/u, '');
      if (terminalKey(literal) && terminalKey(literal) === terminalKey(completed.slots.text)) {
        completed = { ...completed, slots: { ...completed.slots, text: literal } };
      }
    }
  }
  return completed;
}

function unquote(text) {
  for (const [open, close] of [['“', '”'], ['「', '」'], ['"', '"']]) {
    if (text.startsWith(open) && text.endsWith(close)) return text.slice(1, -1);
  }
  return text;
}
