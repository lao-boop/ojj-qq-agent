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
