import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { renderHum } from './music.js';
import { webSearch } from './websearch.js';
import { lookupPart } from './parts.js';
import { addGlobalFact, isOwner, loadGlobal } from './global.js';
import { addRelay, canRelay, findContact, markDelivered, peekPending } from './relay.js';
import { formatMediaList, searchMedia } from './media-log.js';

const STICKER_DIR = path.join(DATA_DIR, 'stickers');
const STICKER_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** 分类的中文标签，用来写进工具描述帮模型选。 */
const CATEGORY_HINTS = {
  happy: '开心、庆祝',
  approval: '赞同、答应',
  angry: '生气、不满',
  sad: '难过、委屈',
  confused: '疑惑、没懂',
  surprised: '惊讶、震惊',
  shy: '害羞、尴尬',
  tired: '累、困、摆烂',
  eating: '吃饭、投喂',
  affection: '喜欢、贴贴、安慰',
  greeting: '打招呼、早晚安',
  refusal: '拒绝、不行',
  teasing: '吐槽、调侃、坏笑',
  action: '动作、忙、跑',
  reply: '普通回应',
};

/** 允许模型/用户说中文分类名。 */
const CATEGORY_ALIASES = {
  开心: 'happy', 高兴: 'happy', 庆祝: 'happy', 笑: 'happy',
  赞同: 'approval', 同意: 'approval', 点赞: 'approval',
  生气: 'angry', 愤怒: 'angry', 不满: 'angry',
  难过: 'sad', 伤心: 'sad', 委屈: 'sad', 哭: 'sad',
  疑惑: 'confused', 不懂: 'confused', 问号: 'confused',
  惊讶: 'surprised', 震惊: 'surprised', 吃惊: 'surprised',
  害羞: 'shy', 尴尬: 'shy', 脸红: 'shy',
  累: 'tired', 困: 'tired', 疲惫: 'tired', 摆烂: 'tired', 无语: 'tired',
  吃饭: 'eating', 吃: 'eating', 美食: 'eating', 投喂: 'eating',
  喜欢: 'affection', 贴贴: 'affection', 安慰: 'affection', 爱心: 'affection',
  打招呼: 'greeting', 问候: 'greeting', 早安: 'greeting', 晚安: 'greeting',
  拒绝: 'refusal', 不行: 'refusal', 不要: 'refusal',
  吐槽: 'teasing', 调侃: 'teasing', 坏笑: 'teasing', 玩梗: 'teasing',
  动作: 'action', 忙: 'action', 跑: 'action',
  回应: 'reply', 普通: 'reply',
};

function resolveCategory(input, available) {
  const raw = String(input || '').trim();
  if (!raw) return available.includes('reply') ? 'reply' : available[0];
  const lower = raw.toLowerCase();
  if (available.includes(lower)) return lower;
  if (CATEGORY_ALIASES[raw] && available.includes(CATEGORY_ALIASES[raw])) return CATEGORY_ALIASES[raw];
  const fuzzy = available.find((c) => c.includes(lower) || lower.includes(c));
  return fuzzy || '';
}

/** 扫描 data/stickers/<分类>/ 下的表情包，返回 { 分类: [文件...] }。 */
export function scanStickers() {
  const out = {};
  try {
    for (const entry of fs.readdirSync(STICKER_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = fs
        .readdirSync(path.join(STICKER_DIR, entry.name))
        .filter((f) => STICKER_EXT.has(path.extname(f).toLowerCase()))
        .map((f) => path.join(STICKER_DIR, entry.name, f));
      if (files.length) out[entry.name] = files;
    }
  } catch {
    /* 没有表情包目录就跳过 */
  }
  return out;
}

export const SPECS = {
  draw_image: {
    type: 'function',
    function: {
      name: 'draw_image',
      description:
        '画一张图并发给对方。当对方要图、要你画东西、想看照片/插画、或者你想用画面表达时调用。' +
        'prompt 尽量用英文短语写画面本身（主体、动作、场景、光线、画风），英文出图效果明显更好；写不出英文就写中文，会自动翻译。' +
        '对方说画鲸鱼就画鲸鱼、画猫就画猫，除非对方明确要画你，否则不要把自己写进去。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述（优先英文），尽量具体：主体、动作、场景、光线、画风' },
          size: {
            type: 'string',
            description: '尺寸，可选：square / portrait / landscape / wide / tall，或 1024x1024 这样的格式',
          },
        },
        required: ['prompt'],
      },
    },
  },
  get_time: {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取当前本地日期、时间和星期几。回答“现在几点/今天几号/星期几”前先调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  remember: {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '把对方的重要信息长期记住，比如名字、生日、正在忙的事、喜好、约定。只记真正值得记的，不要记闲聊。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '一条简短的事实，不超过 50 字' } },
        required: ['text'],
      },
    },
  },
  send_voice: {
    type: 'function',
    function: {
      name: 'send_voice',
      description:
        '用语音（晓伊的声音）把一句话说给对方听。对方让你「发语音」「说句话」「念一下」「用声音说」时用；一次不超过 60 字，短句口语，不要长篇大论。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要说的话，口语短句，不超过 60 字' } },
        required: ['text'],
      },
    },
  },
  sing: {
    type: 'function',
    function: {
      name: 'sing',
      description:
        '哼一段旋律当作唱歌（只有哼唱旋律，不会真的唱出歌词）。对方说「哼一段」「来一句」时用。' +
        '用完在回复里可以顺口写一两句歌词，但别假装自己唱出了人声。',
      parameters: {
        type: 'object',
        properties: { lyrics: { type: 'string', description: '可选：想配的歌词，没给就自己编一两句' } },
      },
    },
  },
  sing_song: {
    type: 'function',
    function: {
      name: 'sing_song',
      description:
        '生成一首完整的歌（有真人声演唱 + 伴奏，1~2 分钟出结果，会以文件发出去）。' +
        '对方说「唱一首完整的歌」「写首歌」「唱给我听」且想要成品时用这个；只想听哼两句就用 sing。' +
        '歌词你可以自己写，用 [verse] [chorus] 分段；style 写风格/心情/乐器。',
      parameters: {
        type: 'object',
        properties: {
          lyrics: { type: 'string', description: '歌词，带 [verse]/[chorus] 分段，中文即可' },
          style: { type: 'string', description: '风格描述，例如 gentle seaside folk, soft female vocal, acoustic guitar' },
          title: { type: 'string', description: '歌名，可选' },
          seconds: { type: 'number', description: '时长秒数，默认 30，最长 60' },
        },
        required: ['lyrics'],
      },
    },
  },
  post_qzone: {
    type: 'function',
    function: {
      name: 'post_qzone',
      description:
        '在 QQ 空间发一条说说（会自动配一张图）。对方说「发条说说」「发个动态」「发空间」「更新一下空间」时用。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '说说正文，1~2 句口语，符合你的人设' },
          image: { type: 'string', description: '可选：配图的英文画面描述；不填就按正文自动配图' },
          withImage: { type: 'boolean', description: '是否配图，默认 true' },
        },
        required: ['content'],
      },
    },
  },
  make_ppt: {
    type: 'function',
    function: {
      name: 'make_ppt',
      description:
        '做一份 PPT（.pptx 文件）。对方要「做个PPT」「汇报材料」「演示文稿」「课件」时用。会自己写大纲、排版、配图。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '主题，尽量具体，比如“朱元璋生平：从乞丐到开国皇帝”' },
          pages: { type: 'number', description: '正文页数，默认 12，范围 5~20' },
          theme: { type: 'string', enum: ['history', 'business', 'fresh'], description: '配色主题，历史/商务/清新' },
        },
        required: ['topic'],
      },
    },
  },
  make_docx: {
    type: 'function',
    function: {
      name: 'make_docx',
      description: '写一份 Word 文档（.docx）。对方要「写个报告」「方案」「总结」「Word」时用。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '主题' },
          sections: { type: 'number', description: '小节数量，默认 5，范围 3~10' },
        },
        required: ['topic'],
      },
    },
  },
  search_history: {
    type: 'function',
    function: {
      name: 'search_history',
      description:
        '在你们过去的聊天记录里搜索关键词。对方问「我之前说过什么」「你还记得吗」「上次那个…」时，先用它查，再回答，不要瞎猜。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键词，可以多给几个，用空格分开' },
          limit: { type: 'number', description: '返回条数，默认 8，最多 12' },
        },
        required: ['query'],
      },
    },
  },
  search_web: {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        '联网搜索。遇到你不认识的网络热梗、新词、新闻、时效信息，或对方问「你知道吗/帮我查一下」时用它，不要硬猜。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，尽量具体，比如“嘉豪 是什么梗”' },
        },
        required: ['query'],
      },
    },
  },
  make_excel: {
    type: 'function',
    function: {
      name: 'make_excel',
      description:
        '生成 Excel 表格（.xlsx）。对方要「做个表格」「Excel」「清单」「统计表」「报价单」时用，会自动填合理的数据。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '表格主题，尽量具体，比如“奶茶店一周销售流水”' },
          rows: { type: 'number', description: '行数，默认 10，范围 3~50' },
          columns: { type: 'number', description: '列数，默认 5，范围 2~10' },
        },
        required: ['topic'],
      },
    },
  },
  lookup_part: {
    type: 'function',
    function: {
      name: 'lookup_part',
      description:
        '查汽修配件分类库（24 类）：按中文名、俗称、英文名或外观特征检索，返回 part_id、别名、外观线索、易混项和追问注意。对方问“这是什么配件/这个怎么配/什么型号”且涉及配件时用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '配件名称或俗称，比如“刹车片”“空气滤芯”“火花塞”' },
        },
        required: ['query'],
      },
    },
  },
  remember_global: {
    type: 'function',
    function: {
      name: 'remember_global',
      description:
        '把关于主人的公开信息记到全局记忆（所有和你聊天的人都能看到，比如主人的名字、喜好、称呼）。只有主人本人能用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一条公开事实，比如“主人喜欢打篮球”' },
        },
        required: ['text'],
      },
    },
  },
  relay_message: {
    type: 'function',
    function: {
      name: 'relay_message',
      description:
        '帮对方给主人带一句话（只有主人白名单里的好友能用）。对方说“帮我告诉 Owner…”“帮我转告你主人…”时用。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要转告的内容，尽量保留原话，不超过 200 字' },
        },
        required: ['text'],
      },
    },
  },
  relay_list: {
    type: 'function',
    function: {
      name: 'relay_list',
      description: '查看还有哪些没转告给主人的话（只有主人能用）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  relay_to_friend: {
    type: 'function',
    function: {
      name: 'relay_to_friend',
      description:
        '主人让给某个好友带话时用（只有主人能用）。主人说“帮我告诉 好友A……”“给某某发一句……”时调用，会立刻发出去。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '对方的昵称或 QQ 号' },
          text: { type: 'string', description: '要发的内容，保留原话，不超过 200 字' },
        },
        required: ['to', 'text'],
      },
    },
  },
  find_media: {
    type: 'function',
    function: {
      name: 'find_media',
      description:
        '在长期文件记忆里查历史收发的文件、图片、音频（含文件名和内容摘要）。对方问“我之前发你的那个表格”“上周那份报价单”“你发给我的那首歌”时用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词，比如“报价单”“docx”“烟火”“PPT”；空字符串表示最近的文件' },
        },
      },
    },
  },
};

/**
 * 出图质检：让视觉模型看有没有多余物体/肢体错误/乱码文字。
 * 返回 { bad, issue }，失败就当没问题。
 */
async function checkImageQuality(llm, file, logger, model) {
  if (!llm?.chat) return null;
  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase() === '.png' ? 'png' : 'jpeg';
    const dataUrl = `data:image/${ext};base64,${buf.toString('base64')}`;
    const res = await llm.chat({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '检查这张图有没有明显错误：1) 重复或多出来的物体（比如多出来一个篮球/一只手）2) 肢体、手指错乱 3) 衣服或背景上的乱码文字。' +
                '只输出 JSON：{"bad": true 或 false, "issue": "简短说明哪里错了"}。没问题就 bad=false。',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      model: model || 'deepseek-flash',
      maxTokens: 500,
      temperature: 0,
    });
    const text = String(res.content || '');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return { bad: Boolean(parsed.bad), issue: String(parsed.issue || '').slice(0, 80) };
  } catch (err) {
    logger?.warn?.(`出图质检失败：${err.message}`);
    return null;
  }
}

const QUALITY_SUFFIX =
  '。画面里只出现一个主体和必要道具，不要重复物体，不要多出来的球或手，肢体比例正常，不要文字、字母、数字、logo、水印';

/**
 * 组装可用工具。
 * ctx: { chatKey, images: [], voices: [], memory }
 */
export function createTools({ cfg, llm, imageGen, tts, songGen, qzone, office, relayNotify, friendNotify, jobTracker, logger }) {
  const stickers = scanStickers();
  const stickerCats = Object.keys(stickers);
  const specs = [SPECS.draw_image, SPECS.get_time, SPECS.remember, SPECS.sing, SPECS.search_history, SPECS.search_web];
  if (cfg.tts?.enabled && tts) specs.push(SPECS.send_voice);
  if (songGen?.enabled) specs.push(SPECS.sing_song);
  if (qzone?.enabled) specs.push(SPECS.post_qzone);
  if (office) specs.push(SPECS.make_ppt, SPECS.make_docx, SPECS.make_excel);
  specs.push(
    SPECS.lookup_part,
    SPECS.remember_global,
    SPECS.relay_message,
    SPECS.relay_list,
    SPECS.relay_to_friend,
    SPECS.find_media,
  );
  if (stickerCats.length) {
    const labels = stickerCats.map((c) => `${c}（${CATEGORY_HINTS[c] || c}）`).join('、');
    specs.push({
      type: 'function',
      function: {
        name: 'send_sticker',
        description: `发一张表情包。可用分类：${labels}。挑最贴合当下情绪的一类，一张就够，别连着发；对方说「来个表情/发个表情包/斗图」时**必须调用本工具**发一张，不能只回文字。`,
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: stickerCats, description: '表情分类' },
          },
          required: ['category'],
        },
      },
    });
  }

  const cooldowns = new Map();
  const recentStickers = new Map();

  async function run(name, args, ctx) {
    const t0 = Date.now();
    try {
      switch (name) {
        case 'draw_image': {
          if (!cfg.image.enabled) return '出图功能现在是关的，画不了。';
          const key = ctx.chatKey;
          const cooldown = Math.max(cfg.image.cooldownMs ?? 0, cfg.image.provider === 'pollinations' ? 45000 : 0);
          const last = cooldowns.get(key) ?? 0;
          if (Date.now() - last < cooldown) {
            return `刚画过一张，等一下再画（还要 ${Math.ceil((cooldown - (Date.now() - last)) / 1000)} 秒）。`;
          }
          const jid = jobTracker?.begin ? jobTracker.begin('draw', `画图：${String(args.prompt || '').slice(0, 24)}`) : '';
          try {
            const prompt = await toImagePrompt(llm, args.prompt, logger, cfg.llm?.helperModel);
            const finalPrompt = `${prompt}${QUALITY_SUFFIX}`;
            logger.info(`出图提示词：${finalPrompt.slice(0, 160)}`);
            let img = await imageGen.generate({ prompt: finalPrompt, size: args.size });
            // 质检：有多余物体/乱码文字就补画一张
            const qa = await checkImageQuality(llm, img.file, logger, cfg.llm?.visionModel);
            if (qa?.bad) {
              logger.warn(`出图质检不合格：${qa.issue}`);
              const retryPrompt = `${prompt}。严格避免以下问题：${qa.issue || '多余物体、肢体错误、乱码文字'}${QUALITY_SUFFIX}`;
              const second = await imageGen.generate({ prompt: retryPrompt, size: args.size }).catch((err) => {
                logger.warn(`补画失败，用第一张：${err.message}`);
                return null;
              });
              if (second) img = second;
            }
            cooldowns.set(key, Date.now());
            ctx.images.push(img);
            return `已生成图片：${img.width}x${img.height}。回复里用一句话轻松带过，不要输出路径或链接。`;
          } catch (err) {
            cooldowns.set(key, Date.now());
            if (err.retryAfter) return `这次没画成：${err.message}。跟对方说一声，等会儿再画。`;
            throw err;
          } finally {
            if (jid) jobTracker.end(jid);
          }
        }
        case 'get_time': {
          const now = new Date();
          const week = '日一二三四五六'[now.getDay()];
          return `${now.toLocaleString('zh-CN', { hour12: false })} 星期${week}`;
        }
        case 'send_voice': {
          if (!cfg.tts?.enabled || !tts) return '语音功能现在是关的。';
          const audio = await tts.synthesize(args.text);
          ctx.voices.push(audio);
          return `已用语音发出（音色 ${audio.voice}）。回复里用一句话带过就行，不要重复语音内容。`;
        }
        case 'make_ppt': {
          if (!office) return '文档功能没开。';
          const pages = Math.min(Math.max(Number(args.pages) || 12, 5), 20);
          const topic = String(args.topic || '').slice(0, 150).trim();
          if (!topic) return '主题为空。';
          ctx.documents.push({
            kind: 'ppt',
            topic,
            pages,
            theme: String(args.theme || cfg.office?.theme || 'history'),
          });
          return `PPT 安排上了（约 ${pages} 页），一两分钟做好我直接发文件。回复里说一声“在做”就行。`;
        }
        case 'make_docx': {
          if (!office) return '文档功能没开。';
          const sections = Math.min(Math.max(Number(args.sections) || 5, 3), 10);
          const topic = String(args.topic || '').slice(0, 150).trim();
          if (!topic) return '主题为空。';
          ctx.documents.push({ kind: 'docx', topic, sections });
          return `Word 开始写了（${sections} 个小节），一会儿发文件给你。`;
        }
        case 'make_excel': {
          if (!office) return '表格功能没开。';
          const topic = String(args.topic || '').slice(0, 150).trim();
          if (!topic) return '主题为空。';
          const rows = Math.min(Math.max(Number(args.rows) || 10, 3), 50);
          const columns = Math.min(Math.max(Number(args.columns) || 5, 2), 10);
          ctx.documents.push({ kind: 'excel', topic, rows, columns });
          return `表格开始做了（约 ${rows} 行 × ${columns} 列），半分钟就好。`;
        }
        case 'lookup_part': {
          const q = String(args.query || '').trim();
          if (!q) return '要查什么配件？';
          const rows = lookupPart(q, { limit: 3 });
          if (!rows.length) return `分类库里没有匹配「${q}」的条目。告诉对方需要更多信息（位置/照片/车型），不要编。`;
          const lines = rows.map(
            (r) =>
              `${r.part_id} ${r.name_zh}（${(r.aliases || []).join('/')}）｜外观：${r.visual_cues}｜易混：${(r.confusable_part_ids || []).join(',') || '无'}｜注意：${r.clarification_note}`,
          );
          return `配件分类库匹配结果：\n${lines.join('\n')}\n回复时用口语说类别和需要补充的信息，不要报 part_id，也不要承诺适配或价格。`;
        }
        case 'remember_global': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能改公开记忆。';
          const ok = addGlobalFact(args.text);
          return ok ? `记到公开记忆里了：${args.text}（以后所有人都能看到这条）` : '这条已经记过了。';
        }
        case 'relay_message': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          const uin = m?.[1];
          if (!uin) return '群聊里不能传话，私聊找我才行。';
          if (!canRelay(uin, cfg)) return '主人没给我这个权限，不能帮你传话。';
          try {
            const item = addRelay({ uin, name: ctx.peerName || '', text: args.text }, cfg);
            let pushed = false;
            if (relayNotify) {
              try {
                pushed = await relayNotify(item);
              } catch (err) {
                logger?.warn?.(`立即转告失败：${err.message}`);
              }
            }
            if (pushed) {
              markDelivered([item.id]);
              return '已经直接发给主人了。回复里自然说一句“帮你转告了”就行，别报条数。';
            }
            return '好，我记下了，等主人上线就转告他。回复里自然说一句就行，别报条数。';
          } catch (err) {
            return `没传成：${err.message}`;
          }
        }
        case 'relay_list': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能看。';
          const items = peekPending();
          if (!items.length) return '现在没有待转告的话。';
          return `还有 ${items.length} 条没转告：\n${items.map((i) => `- ${i.name || i.from}：${i.text}`).join('\n')}`;
        }
        case 'relay_to_friend': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能让我给别人带话。';
          const text = String(args.text || '').trim().slice(0, 200);
          if (!text) return '内容为空。';
          const c = findContact(args.to);
          if (!c) return `没找到「${args.to}」，直接给我 QQ 号，或者让对方先跟我说句话。`;
          if (!friendNotify) return '发送通道没接好。';
          const ownerName = loadGlobal()?.owner?.name || '主人';
          await friendNotify(c.uin, `【传话】${ownerName} 让我跟你说：${text}`);
          return `已经直接发给 ${c.name}（${c.uin}）了。回复里说一句“发过去了”就行。`;
        }
        case 'find_media': {
          const items = searchMedia(args.keyword || '', ctx.chatKey, 10);
          if (!items.length) return '文件记忆里没有匹配的记录。';
          return `文件记忆里找到这些：\n${formatMediaList(items)}\n回复时用口语说，不要报路径。`;
        }
        case 'post_qzone': {
          if (!qzone?.enabled) return '空间功能没开。';
          const content = String(args.content || '').slice(0, 300).trim();
          if (!content) return '说说内容为空，先想一句话。';
          const imagePrompt = String(args.image || '').trim() || content;
          const imagePath = args.withImage === false ? '' : await qzone.makeImage(imagePrompt);
          await qzone.post({ content, imagePath, source: 'tool', chatKey: ctx.chatKey });
          return `说说发出去了${imagePath ? '，配图也一起传了' : '（这次没配图）'}。回复里自然提一句就行，不要报 tid、路径或链接。`;
        }
        case 'sing': {
          const m = cfg.music || {};
          const min = m.minSeconds ?? 18;
          const max = Math.max(min, m.maxSeconds ?? 30);
          const seconds = min + Math.floor(Math.random() * (max - min + 1));
          const hum = renderHum({ seconds, tempo: m.tempo, noise: m.noise });
          ctx.voices.push({ file: hum.file, name: hum.name, hum: true });
          return `已经哼好一段 ${seconds} 秒的旋律并用语音发出。回复里用一句话带过，可以顺口写一两句歌词，但别声称自己唱出了人声。`;
        }
        case 'sing_song': {
          if (!songGen?.enabled) return '完整的歌还没接上，先给你哼一段吧。';
          const seconds = Math.min(Math.max(Number(args.seconds) || cfg.song.defaultSeconds || 30, 10), cfg.song.maxSeconds || 60);
          ctx.songs.push({
            lyrics: String(args.lyrics || '').slice(0, 3000),
            style: String(args.style || '').slice(0, 400),
            title: String(args.title || '').slice(0, 60),
            seconds,
          });
          return `歌已经交给编曲了：大约 ${seconds} 秒，1~2 分钟出结果，好了会直接发文件。回复里跟对方说一声“正在写”就行，别说已经唱完了。`;
        }
        case 'remember': {
          const ok = ctx.memory.addNote(ctx.chatKey, args.text);
          return ok ? `记住了：${args.text}` : '这条已经记过了。';
        }
        case 'search_history': {
          const q = String(args.query || '').trim();
          if (!q) return '要搜什么关键词？';
          const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 12);
          const hits = await ctx.memory.search(ctx.chatKey, q, { limit });
          if (!hits.length) return `没搜到和「${q}」相关的旧对话。回复里可以说记不清了，别编。`;
          const lines = hits.map(
            (h) => `${h.role === 'user' ? '对方' : h.role === 'assistant' ? '你' : '笔记'}：${h.content.slice(0, 80)}`,
          );
          return `搜到这些旧记录（按相关度）：\n${lines.join('\n')}`;
        }
        case 'search_web': {
          const q = String(args.query || '').trim();
          if (!q) return '要搜什么？';
          const items = await webSearch(q, { limit: 5 });
          if (!items.length) return `没搜到「${q}」的结果。回复里说没查到，别编。`;
          const lines = items.map(
            (i, idx) => `${idx + 1}. ${i.title}${i.snippet ? `：${i.snippet.slice(0, 90)}` : ''}`,
          );
          return `搜索结果（${items.length} 条）：\n${lines.join('\n')}\n用自然口语总结给对方面，不要报链接。`;
        }
        case 'send_sticker': {
          const cat = resolveCategory(args.category, stickerCats);
          const list = cat ? stickers[cat] : null;
          if (!list?.length) {
            return `没有这个分类的表情包，可用：${stickerCats.map((c) => `${c}(${CATEGORY_HINTS[c] || c})`).join('、')}`;
          }
          const recent = recentStickers.get(ctx.chatKey) ?? [];
          const pool = list.filter((f) => !recent.includes(f));
          const from = pool.length ? pool : list;
          const file = from[Math.floor(Math.random() * from.length)];
          recent.push(file);
          while (recent.length > 8) recent.shift();
          recentStickers.set(ctx.chatKey, recent);
          ctx.images.push({ file, name: path.basename(file), sticker: true });
          return `已发送一张「${cat}」表情包。回复里一句话带过就行。`;
        }
        default:
          return `未知工具：${name}`;
      }
    } catch (err) {
      logger.warn(`工具 ${name} 失败：${err.message}`);
      return `工具执行失败：${err.message}`;
    } finally {
      logger.info(`工具 ${name} 用时 ${Date.now() - t0}ms`);
    }
  }

  return { specs, run, stickerCats, imageEnabled: Boolean(cfg.image.enabled), ttsEnabled: Boolean(cfg.tts?.enabled) };
}

/** 中文提示词先翻成英文 tag，出图质量会好很多。用便宜的 flash 模型，不占主模型额度。 */
async function toImagePrompt(llm, prompt, logger, helperModel) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('空提示词');
  const hasCJK = /[\u4e00-\u9fff]/.test(text);
  let english = text;
  if (hasCJK) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await llm.chat({
          messages: [
            {
              role: 'system',
              content:
                '把用户的中文画面描述翻译成英文 AI 绘画提示词：逗号分隔的短标签，按「主体（保留原意，鲸鱼就是鲸鱼，不要翻成人）、外观、动作、场景、光线、构图、画风」排列。' +
                '画风默认 anime illustration / illustration，除非用户明确要照片或写实。只输出英文提示词本身，不要引号、不要解释。',
            },
            { role: 'user', content: text },
          ],
          model: helperModel || llm.cfg.visionModel,
          maxTokens: 400,
          temperature: 0.3,
        });
        const out = (res.content || '').trim().replace(/^["'`]+|["'`]+$/g, '');
        if (out.length >= 8 && !/[\u4e00-\u9fff]/.test(out)) {
          english = out;
          break;
        }
        logger.warn(`提示词翻译结果不合格（第 ${attempt + 1} 次）：${out.slice(0, 40) || '空'}`);
      } catch (err) {
        logger.warn(`提示词翻译失败（第 ${attempt + 1} 次）：${err.message}`);
      }
    }
  }
  const suffix = hasCJK && /[\u4e00-\u9fff]/.test(english) ? 'anime illustration, best quality, detailed' : 'best quality, detailed, soft lighting';
  return `${english}, ${suffix}`;
}
