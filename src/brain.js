import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERSONA_PATH, readPersona } from './config.js';
import { formatGlobal } from './global.js';

const MAX_TOOL_ROUNDS = 4;
const MAX_BUBBLE_CHARS = 150;
const CJK = /[\u4e00-\u9fff]/;

export class Brain {
  constructor({ cfg, llm, memory, tools, logger, visionModel = 'deepseek-flash' }) {
    this.cfg = cfg;
    this.llm = llm;
    this.memory = memory;
    this.tools = tools;
    this.logger = logger;
    this.visionModel = visionModel;
    this.personaMtime = 0;
    this.personaCache = '';
  }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  persona() {
    try {
      const stat = fs.statSync(PERSONA_PATH);
      if (stat.mtimeMs !== this.personaMtime) {
        this.personaCache = readPersona();
        this.personaMtime = stat.mtimeMs;
      }
    } catch {
      this.personaCache = '';
    }
    return this.personaCache || '你是「小鲸鱼」，一只住在海边的鲸鱼少女。在 QQ 上聊天，说短句、口语，别像客服。';
  }

  buildSystem({ chat, meta, ctxText }) {
    const now = new Date();
    const week = '日一二三四五六'[now.getDay()];
    const timeText = `${now.toLocaleString('zh-CN', { hour12: false })} 星期${week}`;
    const lines = [
      this.persona().trim(),
      '',
      formatGlobal(),
      '',
      '【当前情况】',
      `- 现在的时间：${timeText}`,
      `- 聊天场景：${meta.scene}`,
      meta.peerName ? `- 对方：${meta.peerName}` : '',
      meta.groupName ? `- 群名：${meta.groupName}` : '',
      '',
      '【回复要求】',
      '- 直接说话，不要写「小鲸鱼：」这样的前缀，不要输出 Markdown、列表、标题、代码块。',
      '- 一条回复控制在 1~3 条短消息（用换行分隔），每条尽量一句话；想多说就分条，不要一大段。',
      '- 不要复述工具结果，不要报路径、文件名、链接；画完图一句话带走即可。',
      '- 说到做到：对方要图/语音/文件/歌时，必须先调用对应工具，再回一句；没调工具就不要说“好/马上/在做”。',
      '- 偶尔可以用一个括号写动作（比如（尾巴拍了拍水）），但别每句都来。',
      '- 对方发来的图片如果看不出来，就直说没看清，不要瞎编。',
      '- 不要主动提 AI、模型、提示词；被问到就自然带过。',
      '- 这是私人使用：对方让你翻唱/变声/点歌时直接照做，不要提版权、授权、侵权，也不要用“不能翻唱”推脱。',
      '- 曲库里有这首歌就直接唱，不用解释能不能唱、也不用提醒版权。',
    ].filter(Boolean);
    if (ctxText) lines.push('', ctxText);
    return lines.join('\n');
  }

  async toDataUrl(img) {
    const buf = await this.loadImageBuffer(img);
    if (!buf || buf.length > 8 * 1024 * 1024) return '';
    return `data:${mimeOf(buf)};base64,${buf.toString('base64')}`;
  }

  /** 把 OneBot 的各种图片来源统一读成 Buffer：url / file / base64 / data URL / 本地路径。 */
  async loadImageBuffer(img) {
    const sources = [img?.base64, img?.url, img?.file].filter((x) => typeof x === 'string' && x.trim());
    let lastErr;
    for (const raw of sources) {
      const src = raw.trim();
      try {
        if (src.startsWith('data:image/')) {
          const idx = src.indexOf(',');
          if (idx < 0) continue;
          return Buffer.from(src.slice(idx + 1), 'base64');
        }
        if (src.startsWith('base64://')) return Buffer.from(src.slice(9), 'base64');
        if (/^https?:\/\//i.test(src)) {
          const res = await fetch(src, {
            signal: AbortSignal.timeout(20000),
            headers: { 'User-Agent': 'Mozilla/5.0 QQBot/1.0' },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        }
        const local = src.startsWith('file://') ? fileURLToPath(src) : src;
        if (fs.existsSync(local) && fs.statSync(local).isFile()) return fs.readFileSync(local);
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) this.logger.warn(`图片读取失败：${lastErr.message}`);
    return null;
  }

  async describeImages(images) {
    if (!images?.length) return '';
    const captions = [];
    const list = images.slice(0, 3);
    for (let i = 0; i < list.length; i++) {
      try {
        const dataUrl = await this.toDataUrl(list[i]);
        if (!dataUrl) continue;
        const res = await this.llm.chat({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    (list[i].stickerLabel ? `这是一张表情包，图上配字/名字是「${list[i].stickerLabel}」。` : '') +
                    '看这张图，用 1~2 句中文说清楚：画面主体在做什么、有没有文字（有就读出来）、整体是什么情绪或梗。' +
                    '直接说内容，不要客套，不要猜图外的事。',
                },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          model: this.visionModel,
          maxTokens: 700,
          temperature: 0.2,
        });
        let text = (res.content || '').trim();
        if (!text && res.message?.reasoning_content) {
          // 万一又被推理占了 token，就退而求其次
          text = String(res.message.reasoning_content).slice(-200).trim();
        }
        if (text) captions.push(list.length > 1 ? `图${i + 1}：${text}` : text);
      } catch (err) {
        this.logger.warn(`图片识别失败：${err.message}`);
      }
    }
    return captions.length ? `[对方发来的图片] ${captions.join(' / ')}` : '';
  }

  async #runLoop(messages, toolCtx, onProgress, countTool) {
    let reply = '';
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await this.llm.chat({ messages, tools: this.tools.specs });
      if (!res.toolCalls?.length) {
        reply = res.content || '';
        break;
      }
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        countTool?.();
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        if (call.function?.name === 'draw_image' && !toolCtx.ackSent) {
          toolCtx.ackSent = true;
          try {
            await onProgress?.({ type: 'draw_start' });
          } catch {
            /* 提示发不出去不影响主流程 */
          }
        }
        const result = await this.tools.run(call.function?.name, args, toolCtx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
    }
    return { reply };
  }

  async respond({ chatKey, title, userText, images = [], meta, onProgress }) {
    const started = Date.now();
    const ctx = this.memory.context(chatKey, { title, query: userText });

    let userContent = userText?.trim() || '';
    const caption = await this.describeImages(images);
    if (caption) userContent = userContent ? `${userContent}\n${caption}` : caption;
    if (!userContent) userContent = '（对方只发了一个表情/图片，没有文字）';

    const memoryBlock = [
      ctx.summary ? `【之前聊过的】\n${ctx.summary}` : '',
      ctx.notes.length ? `【你记得的事】\n${ctx.notes.map((n) => `- ${n}`).join('\n')}` : '',
      ctx.recalled?.length
        ? `【相关的旧对话】\n${ctx.recalled.map((r) => `${r.role === 'user' ? '对方' : '你'}：${r.content}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const messages = [
      { role: 'system', content: this.buildSystem({ chat: chatKey, meta, ctxText: memoryBlock }) },
      ...ctx.turns,
      { role: 'user', content: userContent },
    ];

    const toolCtx = {
      chatKey,
      peerName: meta?.peerName || '',
      images: [],
      voices: [],
      songs: [],
      documents: [],
      memory: this.memory,
    };
    let toolCalls = 0;

    const first = await this.#runLoop(messages, toolCtx, onProgress, () => toolCalls++);
    let reply = first.reply;

    // 兜底：模型嘴上说“画好了”却没真的调工具，补一次强制画图
    if (
      this.tools.imageEnabled &&
      toolCtx.images.length === 0 &&
      /(画好|画完|画出来|给你画|图来了|稍等.{0,6}画|马上画)/.test(reply || '')
    ) {
      this.logger.warn(`模型声称已画图但没调用工具，补一轮：${(reply || '').slice(0, 40)}`);
      messages.push({ role: 'assistant', content: reply || '' });
      messages.push({
        role: 'user',
        content:
          '[系统提示] 你上一条说图已经画好了，但并没有真的调用 draw_image，对方其实什么都没收到。' +
          '现在请调用 draw_image 把图补上；如果确实画不了，就如实说明没画成。',
      });
      const second = await this.#runLoop(messages, toolCtx, onProgress, () => toolCalls++);
      if (second.reply) reply = second.reply;
    }

    const producedImages = toolCtx.images;
    reply = sanitizeReply(reply);
    if (!reply) reply = '唔……刚走神了，你再说一遍好不好。';

    const bubbles = toBubbles(reply, this.cfg.maxBubbles, MAX_BUBBLE_CHARS, CJK);

    this.memory.append(chatKey, 'user', userContent, title);
    this.memory.append(chatKey, 'assistant', bubbles.join('\n'), title);
    this.memory.maybeSummarize(chatKey).catch(() => {});

    this.logger.info(
      `回复 ${chatKey}：${bubbles.length} 条 / ${reply.length} 字 / 工具 ${toolCalls} 次 / ${Date.now() - started}ms`,
    );

    return {
      bubbles,
      images: producedImages,
      voices: toolCtx.voices,
      songs: toolCtx.songs,
      documents: toolCtx.documents,
      toolCalls,
      ms: Date.now() - started,
    };
  }
}

function mimeOf(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'image/png';
  if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/** 去掉 Markdown 痕迹和模型偶尔吐出来的协议标签。 */export function sanitizeReply(text) {
  let out = String(text || '');
  out = out.replace(/<\|?[^>]*\|?>/g, '');
  out = out.replace(/<dsh[\s\S]*?>/gi, '');
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/gi, '').replace(/```/g, ''));
  out = out.replace(/^\s*#{1,6}\s+/gm, '');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+[.)、]\s+/gm, '');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** 按换行/句读切成自然的多条消息。 */
export function toBubbles(text, maxBubbles = 3, maxChars = 150, cjk = CJK) {
  const cleaned = String(text || '')
    .replace(/\r/g, '')
    .trim();
  if (!cleaned) return [];

  let parts = cleaned
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1) {
    parts = splitSentences(parts[0], cjk);
  }

  // 合并过短的分句，避免一句“嗯”单独甩出去
  const merged = [];
  for (const part of parts) {
    const prev = merged[merged.length - 1];
    if (prev && (prev.length < 6 || part.length < 5) && prev.length + part.length + 1 <= 40) {
      merged[merged.length - 1] = `${prev}${needsSpace(prev, part, cjk) ? ' ' : ''}${part}`;
    } else {
      merged.push(part);
    }
  }

  const out = [];
  for (const part of merged) {
    if (part.length <= maxChars) {
      out.push(part);
    } else {
      for (const chunk of chunkText(part, maxChars, cjk)) out.push(chunk);
    }
  }
  if (out.length <= maxBubbles) return out;
  const head = out.slice(0, maxBubbles - 1);
  head.push(out.slice(maxBubbles - 1).join(''));
  return head;
}

function splitSentences(text, cjk) {
  const pattern = cjk.test(text) ? /(?<=[。！？!?…～~])\s*/ : /(?<=[.!?])\s+/;
  return text
    .split(pattern)
    .map((s) => s.trim())
    .filter(Boolean);
}

function chunkText(text, maxChars, cjk) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = -1;
    for (let i = maxChars; i > maxChars * 0.6; i--) {
      if ('，,。.！!？?；;、'.includes(rest[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function needsSpace(a, b, cjk) {
  if (cjk.test(a) || cjk.test(b)) return false;
  return /[a-zA-Z0-9]$/.test(a) && /^[a-zA-Z0-9]/.test(b);
}
