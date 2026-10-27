/** Stable capability boundary. New upstream tools must be assigned explicitly. */
export const AGENTS = Object.freeze({
  secretary: { description: '项目秘书：老板交办、负责人反馈、附件交接、催办和验收。提交不等于完成，实际权限由服务端核验。', tools: ['project_create','project_status','project_update','project_review','project_remind','project_files'] },
  conversation: { description: '日常对话、时间和会话记忆', tools: ['get_time', 'search_history', 'find_media', 'remember', 'remember_global', 'send_sticker'] },
  research: { description: '检索资料，区分事实和不确定信息', tools: ['search_web', 'search_history', 'find_media'] },
  automotive: { description: '汽修配件识别；缺车型/OE/位置时追问，不承诺适配', tools: ['lookup_part', 'search_web'] },
  document: { description: '结合上游结果制作 PPT、Word、Excel；排队不等于完成', tools: ['make_ppt', 'make_docx', 'make_excel'] },
  image: { description: '按用户要求绘图或选择表情', tools: ['draw_image', 'send_sticker'] },
  audio: { description: '语音合成、哼唱、原创歌曲；翻唱由主管在只读核验后调用专用适配器', tools: ['send_voice', 'sing', 'sing_song'] },
});

export function toolAdapter(tools, agent) {
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`Unknown agent: ${agent}`);
  const allowed = new Set(AGENTS[agent].tools);
  const specs = tools.specs.filter(s => allowed.has(s.function.name));
  const available = new Set(specs.map(s => s.function.name));
  return {
    specs,
    async run(name, args, ctx) {
      if (!available.has(name)) throw new Error(`Tool denied for ${agent}: ${name}`);
      return tools.run(name, args, ctx);
    },
  };
}
