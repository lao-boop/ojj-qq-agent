// Keep machine field names and execution state out of user-facing explanations.
const FIELD_LABELS = {
  topic:'主题',format:'文件格式',pages:'PPT总页数',sections:'文档小节数',rows:'数据行数',columns:'数据列数',
  text:'需要朗读或保存的正文',query:'需要查询的内容',prompt:'画面内容',size:'图片尺寸',
  dataText:'原始数据',dataPolicy:'使用真实数据还是示例数据',source:'音频来源',title:'歌名',artist:'歌手或版本',
  startPhrase:'片段起始歌词',seconds:'片段时长',recipient:'接收对象',delivery:'交付位置',
  audience:'面向的读者',style:'内容风格',fileName:'文件名',inputRef:'要处理的材料',
};
export function missingInformation(intent, input) {
  if (!intent.missing?.length) return '';
  if (intent.missing.some(k => ['inputRef','fileName'].includes(k))) {
    const files = input.attachments?.files || [];
    if (!files.length && !input.imageCount) return '还没有收到要处理的附件，请上传文件或粘贴相关内容。';
    return files.length > 1 ? '收到了多个附件，请说明这次要处理哪一个文件。' : '请说明要处理哪份材料，以及需要从中核对或提取什么内容。';
  }
  const labels = [...new Set(intent.missing.map(k => FIELD_LABELS[k]).filter(Boolean))];
  return labels.length ? `还需要补充：${labels.join('、')}。` : '还缺少处理所需的信息，请补充相关材料或说明具体要求。';
}

const OP_LABELS = {'numbers.verify':'计算与条件核对','research.search':'资料查询','automotive.identify':'配件资料查询','memory.read':'历史记录查询','time.read':'时间查询',
  'document.create':'文档制作','image.generate':'图片生成','speech.synthesize':'语音合成','music.compose':'歌曲创作',
  'music.hum':'哼唱','memory.write':'保存私有记忆','memory.publish':'保存公开记忆','sticker.send':'发送表情'};
export function incompleteFeedback(intent, workflow, queued) {
  const missing = new Set(workflow.unfulfilled);
  const messages = [];
  if (missing.has('research.search') || missing.has('automotive.identify')) {
    const target = intent.slots.query ? `“${intent.slots.query}”的资料查询` : '资料查询';
    messages.push(`${target}没有完成，目前没有可核实的结果，暂时无法确认。请查看相关机构的官方资料或公告，或通过官方联系电话核实；也可以稍后重试。`);
  }
  if (missing.has('memory.read')) messages.push('历史记录查询没有完成，目前不能确认过去的记录；请提供关键词、日期或原始内容后再核对。');
  if (missing.has('time.read')) messages.push('时间查询没有完成，请先查看设备时钟，或稍后重试。');
  if (missing.has('numbers.verify')) messages.push('计算与条件核对没有完成，目前不能确认金额或方案是否符合要求。请核对原始数值和限制条件后重试。');
  const blockedDocument = workflow.steps.some(s => s.agent === 'document' && s.status === 'blocked');
  if (blockedDocument) messages.push('依赖这些查询结果的文档没有开始生成。');
  const other = [...missing].filter(op => !['research.search','automotive.identify','memory.read','time.read','numbers.verify'].includes(op) && !(op === 'document.create' && blockedDocument));
  if (messages.length && other.length) messages.push(`另外尚未完成：${other.map(op => OP_LABELS[op] || '请求的操作').join('、')}。`);
  if (!messages.length) messages.push(`这次没有完成：${[...missing].map(op => OP_LABELS[op] || '请求的操作').join('、') || '请求的操作'}。请稍后重试；已经执行的步骤不会自动重做。`);
  if (queued) messages.push('另有生成任务已排队，尚未确认产物生成或送达。');
  return messages.join('\n');
}
