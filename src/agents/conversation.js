// These messages carry no executable instruction. In particular, punctuation
// and emoji are never treated as authorization to resume an existing task.
export function isSocialSignal(input) {
  const text = String(input.instruction || '').trim();
  if (!text || text.length > 120 || input.imageCount || input.caption ||
      input.modalities?.some(m => m !== 'text') ||
      Object.values(input.attachments || {}).some(items => items?.length)) return false;
  return /^(?:[\s，,。.！!？?…～~、；;：:]|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)+$/u.test(text);
}

export function conversationIntent(goal = '回应当前聊天') {
  return { act:'chat', targetId:'', kind:'general', goal, agents:['conversation'],
    operations:['chat.reply'], forbiddenOperations:[], slots:{}, exclude:[], missing:[], clarification:'' };
}

export function isPlainConversation(intent, input) {
  return intent.act === 'chat' && intent.operations.length === 1 && intent.operations[0] === 'chat.reply' &&
    !Object.keys(intent.slots).length && !intent.missing.length && !intent.clarification &&
    !input.imageCount && !input.caption && !input.modalities?.some(m => m !== 'text') &&
    !Object.values(input.attachments || {}).some(items => items?.length);
}

export const CONVERSATION_GUIDANCE = `本轮只在聊天里用文字回应，未获准调用工具或变更任务；不得声称已经保存、取消、生成或发送任何东西，也不承诺未来主动提醒。
顺着最近对话自然接话。逗号、句号、问号、省略号、表情和语气词也可能是在回应，不需要用户提供完整任务。单凭一个标点不能断定对方受伤、生气或有危机；简短回应即可，不分析标点含义。
对玩笑、歌词、调侃先结合上下文，不把一句“你伤害了我”自动升级成沉重的心理咨询。对方明确认真难过时认真回应；明确只是玩笑时轻松接住。别惯性追问“哪里没接住你”“有什么需求”，别把闲聊拉回旧任务或反复解释未开启的功能。
优先遵守用户的字数、格式和直接成稿要求。没有特殊要求时，短消息通常只接一两句，不机械使用固定模板。`;
