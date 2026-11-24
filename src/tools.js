import { toImagePrompt } from './image-prompt.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { renderHum } from './music.js';
import { webSearch } from './websearch.js';
import { lookupPart } from './parts.js';
import { listDocs, markSummarized, latestDoc } from './doc-inbox.js';
import { addGlobalFact, isOwner, loadGlobal } from './global.js';
import { addRelay, canRelay, findContact, markDelivered, peekPending } from './relay.js';
import { cleanRelayContent, parseWhen } from './wecom-relay.js';
import { addReminder, listReminders, cancelLatest } from './reminders.js';
import { formatMediaList, searchMedia } from './media-log.js';
import { searchBili, pickVideo, downloadBili, videoFileName } from './bilibili.js';
import { findPython } from './tts.js';

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

const SPECS = {
  draw_image: {
    type: 'function',
    function: {
      name: 'draw_image',
      description:
        '画一张图并发给对方。当对方要图、要你画东西、想看照片/插画、或者你想用画面表达时调用。' +
        'prompt 保留用户原始画面要求、方位、配饰归属、指定文字与画幅，系统会自动准备绘图说明。' +
        '对方说画鲸鱼就画鲸鱼、画猫就画猫，除非对方明确要画你，否则不要把自己写进去。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '用户的画面描述，保留原语言及明确约束' },
          format: { type: 'string', enum: ['jpg', 'png'], description: '用户明确指定的图片格式' },
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
          pages: { type: 'number', description: '正文页数，默认 12，范围 1~20。封面和封底另计。' },
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
  send_document: {
    type: 'function',
    function: {
      name: 'send_document',
      description:
        '把资料库里已有的 Word / PPT / Excel / PDF 发给对方（按文件名关键词查找）。' +
        '对方说“把之前那个文档发我”“把 XX 的 PPT 发过来”时用。只有主人能用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '文件名关键词，比如“朱棣”“周报”“小安”' },
        },
        required: ['keyword'],
      },
    },
  },
  forward_file: {
    type: 'function',
    function: {
      name: 'forward_file',
      description:
        '把刚收到的文件（Word/PPT/Excel/PDF）原样转发给白名单里的某个好友。' +
        '对方说“把这个发给 XX”“转给 小明”“传给老王”“发给他”时用。只有主人能用。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '好友昵称或 QQ 号' },
          file: { type: 'string', description: '文件名关键词；留空表示最近收到的那份' },
        },
        required: ['to'],
      },
    },
  },
  inbox_list: {
    type: 'function',
    function: {
      name: 'inbox_list',
      description: '查看员工最近私发来的、还没汇总的 Word/PPT/Excel 文档列表。只有主人能用。',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: '看最近多少小时，默认 48' },
        },
      },
    },
  },
  summarize_inbox: {
    type: 'function',
    function: {
      name: 'summarize_inbox',
      description:
        '把员工私发来的 Word/PPT/Excel 汇总成一份 Word（每份文档 3~5 条要点 + 总体概览），' +
        '然后发给主人。老板说“把大家发的文档汇总一下”“整理成一份给我”时用。只有主人能用。',
      parameters: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: '汇总最近多少小时，默认 48' },
          title: { type: 'string', description: '汇总文档标题，可留空' },
        },
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
        '帮对方给主人带一句话（只有主人白名单里的好友能用）。对方说“帮我告诉主人…”“帮我转告你主人…”时用。',
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
        '主人让给某个好友带话时用（只有主人能用）。主人说“帮我告诉 小明……”“给某某发一句……”时调用，会立刻发出去。',
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
  schedule_reminder: {
    type: 'function',
    function: {
      name: 'schedule_reminder',
      description:
        '用户让你在某个时间提醒他/她时调用。例：“明天下午三点提醒我开会”“10分钟后提醒我喝水”。when 填原话里的时间表达，不要自己换算成时间戳。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '到点要提醒的内容，保留原话，不超过 100 字' },
          when: { type: 'string', description: '时间表达，如“明天下午三点”“10分钟后”“周五上午9点”' },
        },
        required: ['text', 'when'],
      },
    },
  },
  list_reminders: {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '查看当前还有哪些提醒没到点。用户问“我有哪些提醒”时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  cancel_reminder: {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: '用户要取消提醒时用。知道提醒内容就把 keyword 填上；不知道就留空取消最近一条。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '提醒内容里的关键词，如“收衣服”“开会”' },
        },
      },
    },
  },
  find_media: {
    type: 'function',
    function: {
      name: 'find_media',
      description:        '在长期文件记忆里查历史收发的文件、图片、音频（含文件名和内容摘要）。对方问“我之前发你的那个表格”“上周那份报价单”“你发给我的那首歌”时用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词，比如“报价单”“docx”“烟火”“PPT”；空字符串表示最近的文件' },
        },
      },
    },
  },
  fetch_video: {
    type: 'function',
    function: {
      name: 'fetch_video',
      description:
        '去 B 站找一个短视频并发给对方（约 5 分钟以内、30MB 以内）。对方说“给我找个 xx 视频”“发个搞笑视频”“找个猫猫视频”时用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '视频关键词，比如“猫猫”“搞笑翻车”“周杰伦演唱会”' },
        },
        required: ['query'],
      },
    },
  },
};

/**
 * 出图质检：让视觉模型看有没有多余物体/肢体错误/乱码文字。
 * 返回 { bad, issue }，失败就当没问题。
 */
async function checkImageQuality(llm, file, logger, model, prompt) {
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
                `核对用户的画面要求：${prompt}。检查主体、颜色、方位和文字要求，同时检查重复物体、肢体异常或乱码。` +
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
    if (typeof parsed?.bad !== 'boolean') return null;
    return { bad: parsed.bad, issue: String(parsed.issue || '').slice(0, 80) };
  } catch (err) {
    logger?.warn?.(`出图质检失败：${err.message}`);
    return null;
  }
}

const QUALITY_SUFFIX = '. Respect the requested composition, object counts and spatial relationships.';

/**
 * 组装可用工具。
 * ctx: { chatKey, images: [], voices: [], memory }
 */
export function createTools({ cfg, llm, imageGen, tts, songGen, qzone, office, onebot, getWecom, wecomDirectory, wecomUsers, relayNotify, friendNotify, jobTracker, logger }) {
  const stickers = scanStickers();
  const stickerCats = Object.keys(stickers);
  const specs = [SPECS.draw_image, SPECS.get_time, SPECS.remember, SPECS.sing, SPECS.search_history, SPECS.search_web];
  if (cfg.tts?.enabled && tts) specs.push(SPECS.send_voice);
  if (songGen?.enabled) specs.push(SPECS.sing_song);
  if (qzone?.enabled) specs.push(SPECS.post_qzone);
  if (office) specs.push(SPECS.make_ppt, SPECS.make_docx, SPECS.make_excel);
  specs.push(
    SPECS.lookup_part,
    SPECS.send_document,
    SPECS.forward_file,
    SPECS.inbox_list,
    SPECS.summarize_inbox,
    SPECS.remember_global,
    SPECS.relay_message,
    SPECS.relay_list,
    SPECS.relay_to_friend,
    SPECS.schedule_reminder,
    SPECS.list_reminders,
    SPECS.cancel_reminder,
    SPECS.find_media,
    SPECS.fetch_video,
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
            const originalPrompt = String(args.prompt || '').trim().slice(0, cfg.image.maxPromptChars);
            const prompt = await toImagePrompt(llm, originalPrompt, logger, cfg.llm?.helperModel);
            const finalPrompt = `${prompt}${QUALITY_SUFFIX}`;
            logger.info(`出图提示词：${finalPrompt.slice(0, 160)}`);

            // 瞬时失败静默重试：不要把“没画成”先丢给用户
            const generate = async (p) => {
              let last;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  return await imageGen.generate({ prompt: p, originalPrompt, size: args.size, prepared: true, format: args.format });
                } catch (err) {
                  last = err;
                  if (err.qualityRejected || err.terminal) throw err;
                  logger.warn(`出图失败（第 ${attempt + 1} 次）：${err.message}`);
                  if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
                }
              }
              throw last;
            };

            let img = await generate(finalPrompt);
            // 质检：有多余物体/乱码文字就补画一张
            const qa = img.reviewed ? null : await checkImageQuality(llm, img.file, logger, cfg.llm?.visionModel, args.prompt);
            if (qa?.bad) {
              logger.warn(`出图质检不合格：${qa.issue}`);
              const retryPrompt = `${prompt}。严格避免以下问题：${qa.issue || '多余物体、肢体错误、乱码文字'}${QUALITY_SUFFIX}`;
              const second = await generate(retryPrompt);
              const review = second.reviewed ? null : await checkImageQuality(llm, second.file, logger, cfg.llm?.visionModel, args.prompt);
              if (!second.reviewed && !review) throw new Error('补画后未能取得画面核验结果');
              if (review?.bad) throw new Error(`补画后仍未通过画面核验：${review.issue || '未满足画面要求'}`);
              img = second;
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
          const pages = Math.min(Math.max(Number(args.pages) || 12, 1), 20);
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
          const topic = String(args.topic || '').trim();
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
        case 'forward_file': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能让我转发文件。';
          if (!onebot) return '发送通道没接上。';
          const to = String(args.to || '').trim();
          if (!to) return '要转给谁？给我昵称或 QQ 号。';

          const contact = findContact(to);
          if (!contact) return `没找到「${to}」。让他先给我发条消息，或者直接把 QQ 号给我。`;

          const allow = (cfg.access?.privateAllow || []).map(String).filter(Boolean);
          if (allow.length && !allow.includes(String(contact.uin))) {
            return `「${contact.name}」不在白名单里，不能转发。`;
          }

          let doc = latestDoc({ chatKey: ctx.chatKey, keyword: String(args.file || '').trim() });
          if (!doc && args.file) doc = latestDoc({ keyword: String(args.file).trim() });

          // 兜底：收件箱里没有，就直接在 data/files、data/documents 里按文件名找
          if (!doc) {
            const kw = String(args.file || '').trim().toLowerCase();
            const dirs = [path.join(DATA_DIR, 'files'), path.join(DATA_DIR, 'documents')];
            const exts = /\.(docx|pptx|xlsx|pdf|doc|ppt|xls)$/i;
            const cands = [];
            for (const dir of dirs) {
              let names = [];
              try {
                names = fs.readdirSync(dir);
              } catch {
                continue;
              }
              for (const name of names) {
                if (!exts.test(name)) continue;
                if (kw && !name.toLowerCase().includes(kw)) continue;
                const full = path.join(dir, name);
                try {
                  const st = fs.statSync(full);
                  if (st.isFile()) cands.push({ path: full, name, mtime: st.mtimeMs });
                } catch {
                  /* skip */
                }
              }
            }
            cands.sort((a, b) => b.mtime - a.mtime);
            if (cands[0]) doc = { path: cands[0].path, name: cands[0].name };
          }

          if (!doc) return '最近没收到可以转发的文件。先把文件发我，我再转。';

          try {
            const buffer = fs.readFileSync(doc.path);
            await onebot.call(
              'upload_private_file',
              { user_id: Number(contact.uin), file: `base64://${buffer.toString('base64')}`, name: doc.name },
              180000,
            );
            await onebot.sendPrivate(Number(contact.uin), [
              { type: 'text', data: { text: `${ctx.peerName || '有人'} 转发：${doc.name}` } },
            ]);
            return `已把《${doc.name}》转给 ${contact.name}（${contact.uin}）。`;
          } catch (err) {
            return `转发失败：${err.message}`;
          }
        }
        case 'inbox_list': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能看汇总箱。';
          const hours = Math.min(Math.max(Number(args.hours) || 48, 1), 720);
          const docs = listDocs({ hours });
          if (!docs.length) return `最近 ${hours} 小时没有待汇总的文档。`;
          const lines = docs.map((d) => {
            const t = new Date(d.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            return `- ${t}｜${d.senderName || d.uin}｜${d.name}｜${d.chars} 字`;
          });
          return `待汇总文档（${docs.length} 份）：\n${lines.join('\n')}\n回复时说清有几份、谁发的，不要报路径。`;
        }
        case 'summarize_inbox': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能让我汇总文档。';
          if (!office) return '文档功能没开。';
          const hours = Math.min(Math.max(Number(args.hours) || 48, 1), 720);
          const docs = listDocs({ hours });
          if (!docs.length) return `最近 ${hours} 小时没有待汇总的文档。`;

          const formatDoc = async (d) => {
            const text = String(d.text || '').slice(0, 3000);
            if (!text) return [`（这份文档没有抽出文字，文件名：${d.name}）`];
            try {
              const res = await llm.chat({
                model: cfg.office?.model || 'deepseek-flash',
                messages: [
                  {
                    role: 'system',
                    content:
                      '把这份文档压缩成 3~5 条要点，中文，每条一行，直接输出要点，不要开场白。' +
                      '保留数字、结论、负责人、时间；不要编造文档里没有的内容。',
                  },
                  { role: 'user', content: `文件名：${d.name}\n\n${text}` },
                ],
                maxTokens: 500,
                temperature: 0.3,
              });
              const bullets = String(res.content || '')
                .split(/\r?\n/)
                .map((s) => s.replace(/^[-*·\d.、\s]+/, '').trim())
                .filter(Boolean)
                .slice(0, 5);
              return bullets.length ? bullets : [text.slice(0, 80)];
            } catch (err) {
              logger?.warn?.(`汇总 ${d.name} 失败：${err.message}`);
              return [text.slice(0, 80)];
            }
          };

          const sections = [];
          const digest = [];
          for (const d of docs) {
            const bullets = await formatDoc(d);
            digest.push(`${d.senderName || d.uin}《${d.name}》：${bullets.join('；')}`);
            sections.push({
              heading: `${d.name}（${d.senderName || d.uin}）`,
              bullets,
            });
          }

          let intro = `共收到 ${docs.length} 份文档，来自 ${new Set(docs.map((d) => d.uin)).size} 位同事。`;
          try {
            const res = await llm.chat({
              model: cfg.office?.model || 'deepseek-flash',
              messages: [
                { role: 'system', content: '用 3~4 句中文概括这批文档的整体情况：谁交了什么、主要进展、需要老板关注的点。不要编造。' },
                { role: 'user', content: digest.join('\n').slice(0, 4000) },
              ],
              maxTokens: 400,
              temperature: 0.4,
            });
            if (res.content?.trim()) intro = res.content.trim();
          } catch {
            /* 用默认开场 */
          }

          const title = String(args.title || `文档汇总 ${new Date().toLocaleDateString('zh-CN')}`).slice(0, 50);
          const built = await office.makeSummaryDocx({
            title,
            subtitle: `共 ${docs.length} 份 · 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
            sections: [{ heading: '总体概览', paragraphs: [intro] }, ...sections],
            theme: cfg.office?.theme || 'business',
          });

          ctx.files.push({ path: built.file, name: built.name, size: fs.statSync(built.file).size });
          markSummarized(docs.map((d) => d.id));
          return `汇总好了：${docs.length} 份文档，已生成《${built.name}》并加入待发送。回复里一句话说明即可。`;
        }
        case 'send_document': {
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能让我发文件。';
          const kw = String(args.keyword || '').trim().toLowerCase();
          if (!kw) return '要发哪个文件？给我一个文件名关键词。';

          const dirs = [path.join(DATA_DIR, 'documents'), path.join(DATA_DIR, 'files')];
          const exts = new Set(['.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls', '.pdf']);
          const found = [];
          for (const dir of dirs) {
            let names = [];
            try {
              names = fs.readdirSync(dir);
            } catch {
              continue;
            }
            for (const name of names) {
              const ext = path.extname(name).toLowerCase();
              if (!exts.has(ext)) continue;
              if (!name.toLowerCase().includes(kw)) continue;
              const full = path.join(dir, name);
              try {
                const st = fs.statSync(full);
                if (!st.isFile()) continue;
                found.push({ path: full, name, size: st.size, mtime: st.mtimeMs });
              } catch {
                /* 跳过读不到的文件 */
              }
            }
          }

          if (!found.length) return `资料库里没找到文件名包含「${args.keyword}」的文档。`;
          found.sort((a, b) => b.mtime - a.mtime);
          const pickFile = found[0];
          ctx.files.push({ path: pickFile.path, name: pickFile.name, size: pickFile.size });
          return `已加入待发送：${pickFile.name}（${Math.round(pickFile.size / 1024)}KB）。回复里一句话带过即可，不要报路径。`;
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
          if (String(ctx.chatKey || '').startsWith('wecom:')) {
            const bossId = String(cfg.wecom?.ownerUserId || process.env.WECOM_OWNER_USERID || '').trim();
            const wx = getWecom?.();
            const text = cleanRelayContent(args.text).slice(0, 200);
            if (!text) return '要转告什么？';
            if (!wx?.enabled) return '企微通道没接好。';
            if (!bossId) return '还没设置老板的企微 userid（WECOM_OWNER_USERID），设好才能传话。';
            if (String(ctx.peerName) === bossId) return '你就是老板，不用转告自己。';
            try {
              await wx.sendTo(bossId, `【传话】${ctx.peerName || '同事'}：${text}`);
              return '已经转告老板了。';
            } catch (err) {
              return `没发出去：${err.message}`;
            }
          }
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
          if (String(ctx.chatKey || '').startsWith('wecom:')) {
            const bossId = String(cfg.wecom?.ownerUserId || process.env.WECOM_OWNER_USERID || '').trim();
            const text = cleanRelayContent(args.text).slice(0, 200);
            if (!text) return '内容为空。';
            if (!bossId) return '还没设置老板的企微 userid（WECOM_OWNER_USERID）。';
            if (String(ctx.peerName) !== bossId) return '只有老板能让我给同事带话。';

            const local = wecomUsers?.findUser(args.to);
            if (local) {
              await getWecom?.().sendTo(local.userid, `【传话】老板：${text}`);
              return `已经发给 ${local.name} 了。`;
            }

            if (wecomDirectory?.enabled) {
              try {
                const target = await wecomDirectory.resolve(args.to);
                if (target) {
                  await getWecom?.().sendTo(target.userid, `【传话】老板：${text}`);
                  return `已经发给 ${target.name} 了。`;
                }
              } catch {
                /* 通讯录不可用就退回本地名字 */
              }
            }

            return `还不认识「${args.to}」。让他在企微里对我说一句“我叫${args.to}”，我记住后就能转。`;
          }
          const m = /^private:(\d+)$/.exec(ctx.chatKey || '');
          if (!isOwner(m?.[1], cfg)) return '只有主人能让我给别人带话。';
          const text = cleanRelayContent(args.text).slice(0, 200);
          if (!text) return '内容为空。';
          const c = findContact(args.to);
          if (!c) return `没找到「${args.to}」，直接给我 QQ 号，或者让对方先跟我说句话。`;
          if (!friendNotify) return '发送通道没接好。';
          const ownerName = loadGlobal()?.owner?.name || '主人';
          await friendNotify(c.uin, `【传话】${ownerName} 让我跟你说：${text}`);
          return `已经直接发给 ${c.name}（${c.uin}）了。回复里说一句“发过去了”就行。`;
        }
        case 'schedule_reminder': {
          const text = String(args.text || '').trim().replace(/^提醒我?\s*/, '').slice(0, 100);
          const whenText = String(args.when || '').trim();
          if (!text) return '要提醒你什么？';
          const when = parseWhen(whenText || text, new Date());
          if (!when) return '要什么时候提醒？比如“明天下午三点”或“10分钟后”。';
          if (when.at < Date.now() + 20000) return '这个时间已经过了，换一个将来的时间吧。';
          const item = addReminder({ chatKey: ctx.chatKey, text, dueAt: when.at });
          const d = new Date(when.at);
          const label = d.toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          logger?.info?.(`提醒已登记：${item.id} ${label} ${text.slice(0, 30)}`);
          return `定好了：${label} 提醒你「${text}」。回复里一句带过就行。`;
        }
        case 'list_reminders': {
          const list = listReminders(ctx.chatKey);
          if (!list.length) return '现在没有待到的提醒。';
          return (
            '待到的提醒：\n' +
            list
              .slice(-10)
              .map((r) => {
                const d = new Date(r.dueAt);
                return `· ${d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} ${r.text}`;
              })
              .join('\n')
          );
        }
        case 'cancel_reminder': {
          const r = cancelLatest(ctx.chatKey, String(args.keyword || '').trim());
          if (!r) return '没有可取消的提醒。';
          return `取消了：${r.text}`;
        }
        case 'find_media': {
          const items = searchMedia(args.keyword || '', ctx.chatKey, 10);
          if (!items.length) return '文件记忆里没有匹配的记录。';
          return `文件记忆里找到这些：\n${formatMediaList(items)}\n回复时用口语说，不要报路径。`;
        }
        case 'fetch_video': {
          const q = String(args.query || '').trim();
          if (!q) return '要找什么视频？';
          try {
            const list = await searchBili(q, 10);
            const pick = pickVideo(list, 300);
            if (!pick) return `B站没搜到合适的「${q}」短视频（15 秒~5 分钟）。换个词试试？`;
            const python = findPython(cfg.office?.pythonPath || cfg.tts?.pythonPath || '');
            const file = await downloadBili(pick.bvid, python);
            ctx.videos.push({ file: file.file, name: videoFileName(pick.title), title: pick.title });
            return `找到《${pick.title}》（${pick.durationText}，UP：${pick.author}），视频已经准备好了。回复里说一句“发你啦”就行，别报链接和路径。`;
          } catch (err) {
            return `视频没弄成：${String(err.message || '').slice(0, 120)}。跟对方说一声，换个词再试试。`;
          }
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

  const nameOf = (s) => s.function?.name;
  const pick = (...names) => specs.filter((s) => names.includes(nameOf(s)));
  const baseSpecs = pick(
    'draw_image',
    'get_time',
    'remember',
    'send_voice',
    'sing',
    'sing_song',
    'search_history',
    'search_web',
    'find_media',
    'remember_global',
    'schedule_reminder',
    'list_reminders',
    'cancel_reminder',
  );
  const docSpecs = pick('make_ppt', 'make_docx', 'make_excel');
  const relaySpecs = pick('relay_message', 'relay_list', 'relay_to_friend');
  const videoSpecs = pick('fetch_video');
  const qzoneSpecs = pick('post_qzone');
  const partSpecs = pick('lookup_part');
  const stickerSpecs = pick('send_sticker');

  /**
   * 按当前这句话挑工具，避免每轮都把 20 多个工具和文档工具塞进请求。
   * 工具定义越少，提示词越短，推理越快。
   */
  function specsFor({ text = '' } = {}) {
    const t = String(text || '');
    const out = [...baseSpecs, ...relaySpecs, ...qzoneSpecs];
    if (/(ppt|幻灯片|文档|word|excel|表格|汇报|报告|作业|论文)/i.test(t)) out.push(...docSpecs);
    if (/(视频|b站|哔哩|短片)/i.test(t)) out.push(...videoSpecs);
    if (/(配件|零件|车架|vin|型号|oem|故障码)/i.test(t)) out.push(...partSpecs);
    if (stickerCats.length) out.push(...stickerSpecs);
    const seen = new Set();
    const picked = out.filter((s) => {
      const n = nameOf(s);
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
    logger?.debug?.(`[tools] 本轮工具 ${picked.length} 个`);
    return picked;
  }

  return {
    specs,
    specsFor,
    run,
    stickerCats,
    imageEnabled: Boolean(cfg.image.enabled),
    ttsEnabled: Boolean(cfg.tts?.enabled),
  };
}

/** 中文提示词先翻成英文 tag，出图质量会好很多。用便宜的 flash 模型，不占主模型额度。 */
