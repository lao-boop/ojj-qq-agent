/** Operations are the execution contract, not merely a routing hint. */
export const CAPABILITIES = Object.freeze({
  'chat.reply': { agent: 'conversation', tools: ['get_time'] },
  'memory.read': { agent: 'conversation', tools: ['search_history','find_media'] },
  'memory.write': { agent: 'conversation', tools: ['remember'] },
  'memory.publish': { agent: 'conversation', tools: ['remember_global'] },
  'document.create': { agent: 'document', tools: ['make_ppt','make_docx','make_excel'] },
  'image.generate': { agent: 'image', tools: ['draw_image'] },
  'image.inspect': { agent: 'conversation', tools: [] },
  'sticker.send': { agent: 'conversation', tools: ['send_sticker'] },
  'speech.synthesize': { agent: 'audio', tools: ['send_voice'] },
  'music.hum': { agent: 'audio', tools: ['sing'] },
  'music.compose': { agent: 'audio', tools: ['sing_song'] },
  'research.search': { agent: 'research', tools: ['search_web'] },
  'automotive.identify': { agent: 'automotive', tools: ['lookup_part','search_web'] },
  'cover.perform': { agent: 'audio', tools: [] },
  'qzone.publish': { agent: 'conversation', tools: [], unsupported: true },
  'relay.send': { agent: 'conversation', tools: [], unsupported: true },
});

export function validateCapabilities(intent, input) {
  const s = intent.slots, ops = intent.operations;
  if (s.delivery === 'other_chat' && intent.kind !== 'cover') return '这项任务还不能直接交付到别人的聊天，请先确认是否改为在当前聊天生成；本次没有生成或转发。';
  if (s.delivery === 'unclear' || (s.recipient && !s.delivery)) return intent.kind === 'cover' ? '你提到的对象是歌手/版本，还是要送给某个人听？请同时确认是在当前聊天播放，还是要发给对方。' : '这份结果是在当前聊天交给你，还是需要发送到对方的聊天？请先确认交付位置。';
  if (ops.some(op => intent.forbiddenOperations.includes(op))) return '你要求的操作同时被禁止了，请明确保留哪项操作。';
  if (ops.some(op => CAPABILITIES[op].unsupported)) return '本次包含尚未接入主管执行的空间发布或传话；不会只执行一部分，请拆开任务。';
  if (intent.kind === 'cover' && (ops.length !== 1 || ops[0] !== 'cover.perform')) return '翻唱与其他操作请分开提出，当前不会只执行一部分。';
  if (intent.kind !== 'cover' && ops.includes('cover.perform')) return '翻唱任务的类型不一致，请明确翻唱来源。';
  if (ops.includes('document.create')) {
    if (!s.format || !s.topic) return '要制作什么主题的文档？请同时说明 PPT、Word 或 Excel。';
    if (!['ppt','docx','excel'].includes(s.format)) return '目前文档格式支持 PPT、Word 和 Excel。';
    if (s.format === 'excel' && !s.dataPolicy) return '表格要使用你提供的真实数据，还是允许生成示例数据？';
    if (s.dataPolicy === 'provided' && !input.attachments?.files?.length && !s.dataText) return '还没有收到所需的真实数据，请提供文件或数据内容；不会编造数值。';
  }
  if (ops.includes('image.generate') && !s.prompt) return '你想画什么？请说明画面内容。';
  if (ops.includes('speech.synthesize') && !s.text) return '这条语音要说什么？请提供要朗读的文字。';
  if (ops.includes('speech.synthesize') && s.text.length > 120) return '朗读文本超过当前单条语音支持的120字，请分段提供；不会悄悄截断。';
  if (ops.includes('memory.publish') && !/(公开|所有人|大家|全局)/.test(input.instruction)) return '这条记忆是否要公开给其他人？目前不会写入公开记忆。';
  if (ops.includes('music.compose') && !s.topic) return '原创歌曲要写什么主题？点唱已有歌曲请提供歌名。';
  if (ops.includes('research.search') && !s.query) return '具体要查询什么内容？';
  if ((ops.includes('memory.write') || ops.includes('memory.publish')) && !s.text) return '要记住的具体内容是什么？';
  if (ops.includes('automotive.identify') && !s.query && !input.caption) return '请提供配件名称、外观描述或清晰图片。';
  if (s.inputRef === 'image' || ops.includes('image.inspect')) {
    if (!input.imageCount) return '没有收到要看的图片，请发送图片。';
    if (input.imageReadFailed) return '图片尚未成功读取，不能据此判断或生成，请重新提供清晰图片。';
  }
  if (s.inputRef === 'file') {
    const files = input.attachments?.files || [];
    if (!files.length) return '没有收到对应文件，请提供要处理的文件。';
    if (s.fileName && !files.some(f => f.name === s.fileName)) return '没有找到指定文件，请确认文件名。';
    if (files.length > 1 && !s.fileName) return '收到了多个文件，请明确这次处理哪一个。';
    if (/读取失败|读不出里面|格式不支持/.test(input.evidence)) return '文件读取尚未完整成功，请重新提供可读取的内容，暂时不据此制作产物。';
  }
  if (s.inputRef === 'history') return '历史附件还没有定位，请先说明文件名或查询历史文件，确认后再处理。';
  if (s.pages && s.format !== 'ppt') return '页数约束目前仅用于 PPT；请明确其他格式的结构要求。';
  return '';
}

export function allowedTools(intent) {
  const names = new Set(intent.operations.flatMap(op => CAPABILITIES[op].tools));
  for (const op of intent.forbiddenOperations) for (const tool of CAPABILITIES[op].tools) names.delete(tool);
  if (intent.slots.format) {
    const chosen = {ppt:'make_ppt',docx:'make_docx',excel:'make_excel'}[intent.slots.format];
    for (const name of ['make_ppt','make_docx','make_excel']) if (name !== chosen) names.delete(name);
  }
  if (intent.readOnly) for (const name of names) if (!['get_time','search_history','find_media','search_web','lookup_part'].includes(name)) names.delete(name);
  return names;
}

/** Pin confirmed parameters at the adapter boundary; models cannot silently replace them. */
export function bindArguments(name, args, intent) {
  const s = intent.slots;
  const out = { ...args };
  const copy = keys => { for (const k of keys) if (s[k] !== undefined) out[k] = s[k]; };
  if (['make_ppt','make_docx','make_excel'].includes(name)) {
    copy(['topic']);
    if (name === 'make_ppt') copy(['pages']);
    if (name === 'make_docx') copy(['sections']);
    if (name === 'make_excel') copy(['rows','columns']);
    out.topic += `\n要求：${JSON.stringify({ audience:s.audience, style:s.style, excluded:intent.exclude, dataPolicy:s.dataPolicy, dataText:s.dataText })}`;
  }
  if (name === 'draw_image') {
    copy(['prompt','size']);
    out.prompt += `\n要求：${JSON.stringify({ style:s.style, excluded:intent.exclude })}`;
  }
  if (['send_voice','remember','remember_global'].includes(name)) copy(['text']);
  if (['search_web','lookup_part'].includes(name)) copy(['query']);
  return out;
}
