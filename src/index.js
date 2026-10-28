import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, deepMerge, writePersona, readPersona, ensureDirs, DATA_DIR, ROOT, applyEnvOverrides } from './config.js';
import { Logger } from './logger.js';
import { OneBot } from './onebot.js';
import { LLM, sleep } from './llm.js';
import { ImageGen } from './image.js';
import { peekPending, markDelivered, upsertContact } from './relay.js';
import { ActionJournal, selfContext } from './self-state.js';
import { GameHub } from './games.js';
import { logMc, formatMcDigest } from './mc-log.js';
import { MC_KNOWLEDGE, mcStatusText } from './mc-knowledge.js';
import { Minecraft } from './minecraft.js';
import { logMedia, formatMediaDigest } from './media-log.js';
import { searchBili, pickVideo, downloadBili, videoFileName } from './bilibili.js';
import { findPython } from './tts.js';
import { Memory } from './memory.js';
import { createTools } from './tools.js';
import { Brain } from './brain.js';
import { TTS } from './tts.js';
import { FileReader } from './files.js';
import { renderHum } from './music.js';
import { SongGen } from './song.js';
import { VoiceConvert } from './cover.js';
import { extractAudio, extractFrame, trimAudio, cutAudioFrom, probeDuration, toMp3, silkToWav } from './media.js';
import { MusicLibrary, extractSongQuery, parseCoverRequest, isCorrection, parseDuration } from './library.js';
import { webSearch } from './websearch.js';
import { Aligner } from './asr.js';
import { localAsrHealthy, localTranscribe } from './asr-local.js';
import * as OpenCC from 'opencc-js';
import { Qzone } from './qzone.js';
import { Office } from './office.js';
import { ReplySender } from './reply.js';
import { ConsoleServer } from './server.js';

const cfg = loadConfig();
ensureDirs();

if (!cfg.llm.apiKey) {
  console.warn('\n[警告] config.json 里还没有填 llm.apiKey，机器人接不上模型。到控制台或直接编辑 config.json 补上。\n');
}

const logger = new Logger({ level: cfg.log.level, file: cfg.log.file, name: 'bot' });

const llm = new LLM(cfg.llm, logger.child('llm'));
const imageGen = new ImageGen(cfg.image, logger.child('image'));
const office = new Office({ cfg: cfg.office, llm, imageGen, logger: logger.child('office') });
const tts = new TTS(cfg.tts, logger.child('tts'));
const fileReader = new FileReader({ cfg: { pythonPath: cfg.tts.pythonPath }, logger: logger.child('files') });
const songGen = new SongGen(cfg.song, logger.child('song'));
const voiceConvert = new VoiceConvert(
  { ...cfg.voice, token: cfg.voice.token || cfg.song.token },
  logger.child('voice'),
);
const library = new MusicLibrary(cfg.library, logger.child('library'));
if (library.enabled) library.scan();
const aligner = new Aligner({ ...cfg.asr, token: cfg.asr.token || cfg.song.token }, logger.child('asr'));
let qzone = null;
const games = new GameHub({ logger: logger.child('games') });
const minecraft = new Minecraft({
  cfg: cfg.mc,
  logger: logger.child('mc'),
  onChat: async (name, message) => {
    const isOwnerName = String(name || '').toLowerCase() === String(cfg.mc?.ownerName || '').toLowerCase();
    const text = String(message || '').trim();
    // 游戏里的“停下/过来”直接处理，不等模型
    if (minecraft.online) {
      if (/^(停|停下|停手|别挖|别打了|别动|暂停)/.test(text)) {
        minecraft.cancelTask();
        try { minecraft.stopFollow(); } catch {}
        try { minecraft.bot?.pathfinder?.setGoal(null); } catch {}
        try { minecraft.say('好，停下了'); } catch {}
        logMc({ kind: '听指令停下', detail: name });
        return;
      }
      if (/^(过来|来我这|来我这边|回来|跟着我)/.test(text)) {
        try {
          const target = minecraft.bot?.players?.[name]?.entity;
          if (target) {
            await minecraft.moveTo(target.position.x, target.position.y, target.position.z).catch(() => {});
            try { minecraft.say('来了'); } catch {}
          }
        } catch {}
        logMc({ kind: '听指令过来', detail: name });
        return;
      }
    }
    try {
      logMc({ kind: '公屏聊天', detail: `${name}：${String(message).slice(0, 80)}` });
      const res = await brain.respond({
        chatKey: isOwnerName ? `private:${cfg.access?.ownerQQ || ''}` : 'mc:server',
        title: `MC ${name}`,
        userText: (() => {
          let state = '';
          try {
            if (minecraft.online) state = mcStatusText(minecraft.snapshot());
          } catch {
            state = '';
          }
          return `${isOwnerName ? '（这是我主人）' : ''}${state}\n${MC_KNOWLEDGE}\n[Minecraft 公屏] ${name}：${message}`;
        })(),
        meta: { scene: 'Minecraft 服务器', peerName: name },
      });
      const text = (res.bubbles || []).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (text) minecraft.say(text);
    } catch (err) {
      logger.warn(`MC 聊天回复失败：${err.message}`);
    }
  },
});
const actionJournal = new ActionJournal({ logger: logger.child('actions') });
const memory = new Memory({ logger: logger.child('memory'), llm, cfg: cfg.chat });
let tools = createTools({ cfg, llm, imageGen, tts, songGen, qzone, office, minecraft, relayNotify: notifyOwnerRelay, friendNotify: notifyFriend, jobTracker: { begin: beginJob, end: endJob }, logger: logger.child('tools') });
const brain = new Brain({
  cfg: cfg.chat,
  llm,
  memory,
  tools,
  logger: logger.child('brain'),
  visionModel: cfg.llm.visionModel,
  selfState: (chatKey) =>
    selfContext({
      chatKey,
      cfg,
      journal: actionJournal,
      runtime: { qzoneInitialized: Boolean(qzone), connected: Boolean(onebot?.status?.().connected) },
    }),
});
const onebot = new OneBot({ wsUrl: cfg.onebot.wsUrl, accessToken: cfg.onebot.accessToken, logger: logger.child('onebot') });
const sender = new ReplySender({ onebot, cfg: cfg.chat, logger: logger.child('reply') });

const stats = { received: 0, replied: 0, ignored: 0, errors: 0, startedAt: Date.now() };
const activeJobs = new Map();
const docJobs = new Map();
const lastDocTopic = new Map();

/** 记一个正在执行的长任务（PPT/写歌/翻唱），控制台能看到。 */
function beginJob(kind, label) {
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  activeJobs.set(id, { id, kind, label: String(label || kind).slice(0, 60), startedAt: Date.now() });
  return id;
}

function endJob(id) {
  activeJobs.delete(id);
}

function busyList() {
  return [...activeJobs.values()].map((j) => ({ ...j, elapsedMs: Date.now() - j.startedAt }));
}

/** 包一层：任务结束自动从“正在干活”里移除。 */
function trackJob(label, promise) {
  const id = beginJob('job', label);
  return promise.finally(() => endJob(id));
}
const chatChains = new Map();
const rateBuckets = new Map();
const groupNames = new Map();

// ---------- 工具函数 ----------

function extractMessage(event) {
  const parsed = parseSegments(event.message);
  return parsed;
}

/** 解析 OneBot 消息段：文字、图片、@、引用。 */
function parseSegments(message) {
  const segments = Array.isArray(message) ? message : [];
  const texts = [];
  const images = [];
  const files = [];
  const audios = [];
  const videos = [];
  let stickerCount = 0;
  let mentioned = false;
  let quoteId = '';
  for (const s of segments) {
    if (s.type === 'text') texts.push(s.data?.text ?? '');
    else if (s.type === 'image') {
      images.push({
        url: s.data?.url,
        file: s.data?.file,
        summary: s.data?.summary,
      });
    } else if (s.type === 'file') {
      const name = s.data?.name || s.data?.file || '';
      const isAudio = /\.(mp3|wav|m4a|ogg|amr|silk|flac|aac|opus)$/i.test(String(name));
      const isVideo = /\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v)$/i.test(String(name));
      const isImage = /\.(jpe?g|png|gif|webp|bmp)$/i.test(String(name));
      if (isImage) {
        images.push({
          name,
          url: s.data?.url,
          file: s.data?.file,
          fileId: s.data?.file_id,
          fromFile: true,
        });
      } else {
        const target = isAudio ? audios : isVideo ? videos : files;
        target.push({
          name,
          size: s.data?.size,
          file: s.data?.file,
          file_id: s.data?.file_id,
          url: s.data?.url,
        });
      }
    } else if (s.type === 'video') {
      videos.push({
        name: s.data?.name || 'video.mp4',
        file: s.data?.file,
        url: s.data?.url,
        file_id: s.data?.file_id,
      });
    } else if (s.type === 'record') {
      audios.push({
        name: s.data?.name || 'voice.silk',
        file: s.data?.file,
        url: s.data?.url,
        file_id: s.data?.file_id,
        source: 'record',
      });
    } else if (s.type === 'mface') {
      // QQ 商城表情/表情包：有图就按图识别，没图至少把文字/名字告诉模型
      stickerCount++;
      const label = s.data?.text || s.data?.summary || '';
      const url = s.data?.url || s.data?.emoji_url || '';
      if (url) images.push({ url, stickerLabel: label });
      else texts.push(label ? `[表情包：${label}]` : '[表情包]');
    } else if (s.type === 'face') {
      stickerCount++;
      texts.push('[QQ表情]');
    } else if (s.type === 'at') {
      if (String(s.data?.qq) === String(onebot.selfId)) mentioned = true;
    } else if (s.type === 'reply') {
      quoteId = String(s.data?.id ?? '');
    }
  }
  return { text: texts.join('').trim(), images, files, audios, videos, stickerCount, mentioned, quoteId };
}

/** 被引用/回复的消息里如果有图，取出来一起识别。 */
async function fetchQuoted(quoteId) {
  if (!quoteId) return null;
  try {
    const data = await onebot.call('get_msg', { message_id: Number(quoteId) }, 8000);
    const message = data?.message ?? data?.data?.message ?? data?.messages?.[0]?.message;
    if (!message) return null;
    const parsed = parseSegments(message);
    return parsed.images.length ? parsed : null;
  } catch (err) {
    logger.debug(`读取引用消息失败：${err.message}`);
    return null;
  }
}

function stripWakeWord(text) {
  let out = text;
  for (const w of cfg.chat.group.wakeWords ?? []) {
    if (!w) continue;
    out = out.replace(new RegExp(`^\\s*${escapeRegExp(w)}[，,。.!！~\\s]*`, 'i'), '');
  }
  return out.trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 对方是不是明确在要表情包。 */
function wantsSticker(text) {
  return /(表情包|表情|斗图|贴图)/.test(String(text || ''));
}

/** 对方是不是在点歌/让哼一段。 */
function wantsSing(text) {
  const t = String(text || '');
  return /(唱首歌|唱一段|唱一个|来首歌|哼一段|哼首歌|哼一个|唱两句|sing)/i.test(t);
}

/** 对方是不是要画图。 */
function wantsDraw(text) {
  return /(画一|画个|画只|画张|帮我画|给我画|绘制|来一张|来张图|生成.*图)/.test(String(text || ''));
}

/** 从“画一只在窗台打哈欠的橘猫”里抠出画面描述。 */
function extractDrawPrompt(text) {
  let t = String(text || '').trim();
  t = t.replace(/^(帮我|给我|麻烦|请|能不能|可以)?\s*(画|绘制|生成|来)\s*(一张|张|一只|只|一个|个|幅)?\s*/g, '');
  return t.slice(0, 80) || '一只在海边的小鲸鱼';
}

/** 按关键词猜一个表情分类，兜底用。 */
function pickStickerCategory(text) {
  const t = String(text || '');
  if (/(生气|气死|烦死|讨厌|滚)/.test(t)) return 'angry';
  if (/(累|困|摆烂|无语|不想动)/.test(t)) return 'tired';
  if (/(难过|伤心|委屈|想哭|呜呜)/.test(t)) return 'sad';
  if (/(害羞|脸红|尴尬|不好意思)/.test(t)) return 'shy';
  if (/(吃|饿|美食|外卖)/.test(t)) return 'eating';
  if (/(害怕|吓|震惊|真的假的)/.test(t)) return 'surprised';
  if (/(喜欢|爱你|贴贴|抱抱)/.test(t)) return 'affection';
  return 'happy';
}

function chatKeyOf(event) {
  return event.message_type === 'group' ? `group:${event.group_id}` : `private:${event.user_id}`;
}

/** 短、没标点、纯文字的私聊消息，先攒一下，避免把一句话拆开答。 */
function shouldBatch(text, isPrivate, hasAttachment = false) {
  if (!isPrivate || hasAttachment) return false;
  const t = String(text || '').trim();
  if (!t || t.startsWith('/')) return false;
  // 太长的单条直接处理，避免把一整段话也拖慢
  if (t.length > 400) return false;
  return true;
}

const pendingEvents = new Map();

/** 把私聊里连续发来的消息攒成一条，安静几秒后再处理。 */
function enqueueEvent(chatKey, event) {
  const entry = pendingEvents.get(chatKey) || { segments: [], timer: null, event };
  entry.segments.push(...(event.message || []).filter(Boolean));
  entry.event = event;
  clearTimeout(entry.timer);
  const segs = event.message || [];
  const text = segs.filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('').trim();
  const hasAttach = segs.some((s) => s.type !== 'text');
  const looksDone = /[。！？!?…~]$/.test(text) || text.length >= 60;
  // 等久一点，让“图片 + 两句话”这种连发尽量并成一次
  const delay = hasAttach ? 4000 : looksDone ? 5000 : 8000;
  entry.timer = setTimeout(() => {
    pendingEvents.delete(chatKey);
    onMessage({ ...entry.event, message: entry.segments, __batch: true }).catch((err) =>
      logger.warn(`合并消息处理失败：${err.message}`),
    );
  }, delay);
  pendingEvents.set(chatKey, entry);
}

const pendingBatches = new Map();
const pendingFiles = new Map();

/** 连续发来的多个 Word/PPT/Excel 攒在一起，只答一次。 */
function enqueueFiles(chatKey, event, segments) {
  const entry = pendingFiles.get(chatKey) || { texts: [], files: [], timer: null, event };
  entry.texts.push(...segments.filter((s) => s.type === 'text'));
  entry.files.push(...segments.filter((s) => s.type === 'file'));
  entry.event = event;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pendingFiles.delete(chatKey);
    const message = [...entry.texts, ...entry.files];
    onMessage({ ...entry.event, message, __batch: true }).catch((err) =>
      logger.warn(`合并文件消息处理失败：${err.message}`),
    );
  }, 2500);
  pendingFiles.set(chatKey, entry);
}

function enqueueBatch(chatKey, event, text) {
  const entry = pendingBatches.get(chatKey) || { texts: [], timer: null, event };
  entry.texts.push(String(text || '').trim());
  entry.event = event;
  clearTimeout(entry.timer);
  const mergedLen = entry.texts.join('').length;
  const last = entry.texts[entry.texts.length - 1] || '';
  // 看起来说完了（有句末标点或已经够长）就早点回；像半句话就多等一会
  const looksDone = /[。！？!?…~]$/.test(last) || mergedLen >= 60;
  const delay = looksDone ? 1400 : 2800;
  entry.timer = setTimeout(() => {
    pendingBatches.delete(chatKey);
    const merged = entry.texts.join('\n');
    onMessage({ ...entry.event, message: [{ type: 'text', data: { text: merged } }], __batch: true }).catch((err) =>
      logger.warn(`合并消息处理失败：${err.message}`),
    );
  }, delay);
  pendingBatches.set(chatKey, entry);
}

function chatOf(event) {
  return event.message_type === 'group'
    ? { type: 'group', groupId: Number(event.group_id), key: `group:${event.group_id}` }
    : { type: 'private', userId: Number(event.user_id), key: `private:${event.user_id}` };
}

function isAdmin(qq) {
  return (cfg.access.adminQQ ?? []).some((x) => String(x) === String(qq));
}

function allowedPrivate(qq) {
  if (cfg.access.mode === 'open') return true;
  if (isAdmin(qq)) return true;
  if ((cfg.access.privateAllow ?? []).some((x) => String(x) === String(qq))) return true;
  const empty =
    !(cfg.access.adminQQ?.length) && !(cfg.access.privateAllow?.length) && !(cfg.access.groupAllow?.length);
  return Boolean(cfg.access.allowAllWhenEmpty && empty);
}

function allowedGroup(groupId) {
  if (cfg.access.mode === 'open') return true;
  if ((cfg.access.groupAllow ?? []).some((x) => String(x) === String(groupId))) return true;
  const empty =
    !(cfg.access.adminQQ?.length) && !(cfg.access.privateAllow?.length) && !(cfg.access.groupAllow?.length);
  return Boolean(cfg.access.allowAllWhenEmpty && empty);
}

function rateLimited(key) {
  const limit = cfg.chat.rateLimit?.perChatPerMinute ?? 0;
  if (!limit) return false;
  const now = Date.now();
  const bucket = (rateBuckets.get(key) ?? []).filter((t) => now - t < 60000);
  if (bucket.length >= limit) {
    rateBuckets.set(key, bucket);
    return true;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return false;
}

function runSerial(key, fn) {
  const prev = chatChains.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (chatChains.get(key) === next) chatChains.delete(key);
    });
  chatChains.set(key, next);
  return next;
}

async function groupName(groupId) {
  if (groupNames.has(groupId)) return groupNames.get(groupId);
  try {
    const info = await onebot.call('get_group_info', { group_id: Number(groupId) }, 8000);
    const name = String(info?.group_name ?? '');
    groupNames.set(groupId, name);
    return name;
  } catch {
    groupNames.set(groupId, '');
    return '';
  }
}

// ---------- 管理指令 ----------

const HELP = [
  '可用指令：',
  '/help 看这条说明',
  '/status 查看运行状态',
  '/reset 清空当前会话的记忆',
  '/draw 画一只猫  — 直接出图',
  '/say 你好呀  — 发一条语音',
  '/sing  — 哼一段旋律（唱歌功能）',
  '/song 歌名  — 生成一首完整的歌（Replicate）',
  '/cover  — 把刚发的语音变声（Replicate RVC）',
  '/点歌 小美满  — 从本地曲库找歌并自动翻唱',
  '/翻唱 江南 从「某句歌词」开始  — 指定从哪句开始唱',
  '/说说 主题  — 发一条 QQ 空间说说（自动配图）',
  '/ppt 主题  — 生成一份 PPT（约 12 页）',
  '/word 主题  — 生成一份 Word 文档',
  '/excel 主题  — 生成一份 Excel 表格',
  '/sticker happy  — 发一张表情包（happy/angry/sad/tired…）',
  '/model deepseek-v4-pro  — 切换模型',
].join('\n');

async function handleCommand(chat, text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.toLowerCase()) {
    case '/help':
      return HELP;
    case '/status': {
      const s = onebot.status();
      return [
        `连接：${s.connected ? '正常' : '断开'}`,
        `账号：${s.nickname || '-'}（${s.selfId || '-'}）`,
        `模型：${cfg.llm.model}`,
        `收到 ${stats.received} 条，回复 ${stats.replied} 次`,
        `运行 ${Math.round((Date.now() - stats.startedAt) / 60000)} 分钟`,
      ].join('\n');
    }
    case '/reset':
      memory.clear(chat.key);
      return '好，之前聊的我都忘了。';
    case '/draw': {
      if (!arg) return '要画什么呀，说个题目。';
      try {
        const prompt = arg;
        const img = await imageGen.generate({ prompt });
        await sender.send(chat, { bubbles: ['画好了。'], images: [img] });
        return '';
      } catch (err) {
        return `画不出来：${err.message}`;
      }
    }
    case '/say': {
      if (!arg) return '要我说什么？';
      try {
        const audio = await tts.synthesize(arg);
        await sender.send(chat, { bubbles: [], voices: [audio] });
        return '';
      } catch (err) {
        return `语音发不出去：${err.message}`;
      }
    }
    case '/点歌':
    case '/cover': {
      if (!voiceConvert.enabled) return '变声服务还没配好。';
      const q = arg;
      if (q && library.enabled) {
        const hits = library.search(q, { limit: 5 });
        if (!hits.length) return `《${q}》我这儿没翻到，换一首？或者我给你写一首。`;
        const hit = hits[0];
        let src = hit.path;
        try {
          if ((cfg.library.maxSeconds ?? 0) > 0) {
            src = await trimAudio(hit.path, cfg.library.maxSeconds, { ffmpeg: cfg.media?.ffmpegPath, tag: 'song' });
          }
        } catch {
          src = hit.path;
        }
        runCoverJob(chat, src, { title: hit.title }).catch(() => {});
        return `找到《${hit.title}》啦，马上开唱～`;
      }
      const recent = lastAudio.get(chat.key);
      if (!recent || Date.now() - recent.at > 30 * 60 * 1000) return '说个歌名（本地曲库里的），或者先发一段音频给我。';
      runCoverJob(chat, recent.path).catch(() => {});
      return '';
    }
    case '/ppt': {
      const topic = arg || '朱元璋生平：从乞丐到开国皇帝';
      trackJob(`PPT：${topic}`, runOfficeJob(chat, { kind: 'ppt', topic, pages: 12, theme: cfg.office?.theme || 'history' })).catch(() => {});
      return '好，PPT 开始做了，一两分钟～';
    }
    case '/excel': {
      const topic = arg || '一周工作安排表';
      trackJob(`表格：${topic}`, runOfficeJob(chat, { kind: 'excel', topic, rows: 10, columns: 5 })).catch(() => {});
      return '好，表格开始做了，半分钟～';
    }
    case '/word': {
      const topic = arg || '工作总结';
      trackJob(`Word：${topic}`, runOfficeJob(chat, { kind: 'docx', topic, sections: 5 })).catch(() => {});
      return '好，Word 开始写了，一会儿发你～';
    }
    case '/说说': {
      if (!qzone?.enabled) return '空间功能没开。';
      qzone
        .postAuto({ topic: arg || '' })
        .then((r) => r && logger.info(`手动说说完成：${r.tid}`))
        .catch((err) => logger.warn(`手动说说失败：${err.message}`));
      return '好，我去发一条～';
    }
    case '/song': {
      if (!songGen.enabled) return '唱歌服务还没配好。';
      const title = arg || '海边的小鲸鱼';
      const job = {
        title,
        style: 'gentle seaside folk, soft female vocal, acoustic guitar, warm',
        lyrics: `[verse]\n海风把星星吹散\n我在浪里转个圈\n[chorus]\n${title}\n把月光哼成歌`,
        seconds: 30,
      };
      trackJob(`写歌：${job.title || '新歌'}`, runSongJob(chat, job)).catch(() => {});
      return '好，正在写，一两分钟后把成品发给你。';
    }
    case '/sing': {
      try {
        const m = cfg.music || {};
        const min = m.minSeconds ?? 18;
        const max = Math.max(min, m.maxSeconds ?? 30);
        const seconds = min + Math.floor(Math.random() * (max - min + 1));
        const hum = renderHum({ seconds, tempo: m.tempo, noise: m.noise });
        await sender.send(chat, { bubbles: ['给你哼一段。'], voices: [{ file: hum.file, name: hum.name, hum: true }] });
        return '';
      } catch (err) {
        return `哼不出来：${err.message}`;
      }
    }
    case '/sticker': {
      if (!tools.stickerCats.length) return '还没放表情包素材。';
      const ctx = { chatKey: chat.key, images: [], voices: [], memory };
      const msg = await tools.run('send_sticker', { category: arg || 'happy' }, ctx);
      if (ctx.images.length) {
        await sender.send(chat, { bubbles: [], images: ctx.images });
        return '';
      }
      return msg;
    }
    case '/model': {
      if (!arg) return `当前模型：${cfg.llm.model}`;
      cfg.llm.model = arg;
      llm.updateConfig(cfg.llm);
      saveConfig(cfg);
      return `模型换成 ${arg} 了。`;
    }
    default:
      return '';
  }
}

// ---------- 消息处理 ----------

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** 从话里判断要哪种文档。 */
function wantDocType(text) {
  const t = String(text || '');
  if (/(ppt|幻灯片|演示文稿|课件)/i.test(t)) return 'ppt';
  if (/(excel|表格|清单|统计表|流水表)/i.test(t)) return 'excel';
  if (/(word|文档|报告|方案|总结)/i.test(t)) return 'docx';
  return '';
}

/** 是不是“真的要我做一份文档”，而不是只是提到/回忆某个文件。 */
function wantsDocCreation(text) {
  const t = String(text || '');
  if (!t) return false;
  // 回忆、提问、引用文件：不做
  if (/(记得|还记得|记不记得|我刚才发|我发给|发给你的|你发的|回忆|想起来|有没有收到|看到了吗)/.test(t)) return false;
  // 必须有明确的“做/写/生成/整理…”动词
  if (!/(做|写|生成|整理|汇总|合并|导出|转成|弄|来一?份|来一?个|帮我做|帮我写|做个|写个|生成个)/.test(t)) return false;
  return Boolean(wantDocType(t));
}


/** 对方是不是在要一段视频（不是自己拍/剪）。 */
function wantsVideoRequest(text) {
  const t = String(text || '');
  if (!/视频/.test(t)) return false;
  if (!/(找|搜|发|来|看|要|给我|整|搬)/.test(t)) return false;
  if (/(拍|剪|做|生成|画|改)/.test(t)) return false;
  return true;
}

/** 从“帮我找个搞笑视频”里抠出“搞笑”。 */
function extractVideoQuery(text) {
  const q = String(text || '')
    .replace(/.*?(找个|找找|搜个|搜一下|搜|发个|来个|要个|给我|找|发|来|看)/, '')
    .replace(/视频.*$/, '')
    .replace(/[，。！？!?、,.\s]/g, '')
    .trim();
  return (q || '搞笑').slice(0, 20);
}

/** 粗暴地抠出文档主题：“帮我做个朱棣生平的PPT” → “朱棣生平”。 */
function extractDocTopic(text, kind) {
  let t = String(text || '').trim();
  t = t.replace(/^(帮我|给我|麻烦|请|能不能|可以|我想|我要)?\s*(做|写|生成|来|整|弄)?\s*(个|一份|一个|份|张)?\s*/g, '');
  t = t.replace(/(的)?\s*(ppt|幻灯片|演示文稿|课件|word|文档|excel|表格|清单|统计表|报告|方案|总结)\s*$/gi, '');
  t = t.replace(/^(ppt|幻灯片|演示文稿|课件|word|文档|excel|表格|清单|统计表)[:：]?\s*/i, '');
  t = t.replace(/^(关于|有关|主题[:：]?)/, '').trim();
  return t.slice(0, 80);
}

const songUsage = new Map();
const activeSongs = new Map();
const coverUsage = new Map();
const lastAudio = new Map();
const prevAudio = new Map();
const lastVideo = new Map();
const lastCover = new Map();
const lastSent = new Map();
const lastNetNotice = new Map();

/** 模型嘴上答应唱歌却没调工具时，帮它把歌词补出来。 */
async function writeLyrics(theme) {
  try {
    const res = await llm.chat({
      messages: [
        {
          role: 'system',
          content:
            '写一小段中文歌词，用 [verse] 和 [chorus] 分段，8~12 行，口语、有画面感、尽量押韵。' +
            '只输出歌词本身，不要解释，不要标题。',
        },
        { role: 'user', content: String(theme).slice(0, 120) },
      ],
      maxTokens: 500,
      temperature: 0.9,
    });
    return (res.content || '').trim();
  } catch {
    return '';
  }
}

/** 对方是不是要翻唱/变声。 */
function wantsCover(text) {
  return /(翻唱|变声|换声|换音|cover)/i.test(String(text || ''));
}

/** 后台变声，完成后以文件发回。 */
async function runCoverJob(chat, audioPath, opts = {}) {
  const limit = cfg.voice.dailyLimit ?? 10;
  const dayKey = `${chat.key}:${new Date().toISOString().slice(0, 10)}`;
  const used = coverUsage.get(dayKey) ?? 0;
  if (limit > 0 && used >= limit) {
    await sender.send(chat, { bubbles: ['今天变声次数用完啦，明天再来找我玩。'] }).catch(() => {});
    return;
  }
  coverUsage.set(dayKey, used + 1);
  lastCover.set(chat.key, { kind: 'audio', path: audioPath, seconds: opts.seconds || 0 });
  const jid = beginJob('cover', `翻唱：${opts.title || '一段音频'}`);
  try {
    if (!opts.quietAck) {
      await sender.send(chat, { bubbles: [pick(['开嗓中，稍等我一下下～', '正在酝酿情绪，马上开唱～', '清一清嗓子，很快～'])] }).catch(() => {});
    }
    // RVC 只认常规音频：QQ 语音是 SILK，先转 wav 再统一转 mp3
    let sourcePath = audioPath;
    if (/\.silk$/i.test(sourcePath)) {
      try {
        sourcePath = await silkToWav(sourcePath, { python: cfg.office?.pythonPath, tag: 'cover' });
      } catch (err) {
        logger.warn(`翻唱前 SILK 解码失败：${err.message}`);
      }
    }
    sourcePath = await toMp3(sourcePath, { ffmpeg: cfg.media?.ffmpegPath, tag: 'cover' }).catch(() => sourcePath);
    const r = await voiceConvert.convert({
      audioPath: sourcePath,
      customModelUrl: cfg.voice.customModelUrl || undefined,
      voice: cfg.voice.rvcModel,
      pitch: cfg.voice.pitchChange,
    });
    const seconds = opts.seconds || (await probeDuration(r.file, { ffmpeg: cfg.media?.ffmpegPath }));
    const text =
      seconds > 55
        ? pick(['唱好啦，这段有点长，发文件给你～', '录好啦，太长啦塞不进语音条，发文件给你～'])
        : pick(['唱好啦，听听看～', '献唱完毕，怎么样？', '唱完了，快夸我～']);
    const generic = /^(刚刚那段|学你唱|你发的这段|一段音频)$/.test(String(opts.title || ''));
    const coverName = String((generic ? '小鲸鱼翻唱' : opts.title) || '小鲸鱼翻唱')
      .replace(/[\\/:*?"<>|]/g, '')
      .slice(0, 40);
    await sender.sendAudio(chat, r.file, `${coverName}.mp3`, text, cfg.voice.sendAsVoice ?? true, seconds);
    memory.append(chat.key, 'assistant', `[我刚翻唱并发送了《${coverName}》的音频文件]`, chat.title);
    lastSent.set(chat.key, { kind: 'cover', title: coverName });
    logMedia({ chatKey: chat.key, direction: 'out', kind: 'audio', name: `${coverName}.mp3`, title: coverName, detail: `${Math.round(seconds)} 秒`, path: r.file });
  } catch (err) {
    logger.warn(`变声失败：${err.message}`);
    await sender.send(chat, { bubbles: [pick(['哎呀，这次没唱成，等会儿再让我试试？', '嗓子卡住了，没唱出来，要不再来一次？'])] }).catch(() => {});
  } finally {
    endJob(jid);
  }
}

/** 后台生成一首歌，完成后以文件形式发回；失败退回哼唱。 */
async function runSongJob(chat, job) {
  job.startedAt = job.startedAt || Date.now();
  const limit = cfg.song.dailyLimit ?? 5;
  const dayKey = `${chat.key}:${new Date().toISOString().slice(0, 10)}`;
  const used = songUsage.get(dayKey) ?? 0;
  if (limit > 0 && used >= limit) {
    await sender.send(chat, { bubbles: ['今天已经唱好多首啦，嗓子要冒烟了，明天再给你唱。'] }).catch(() => {});
    return;
  }
  songUsage.set(dayKey, used + 1);
  activeSongs.set(chat.key, Date.now());
  const songJid = beginJob('song', `写歌：${job.title || '新歌'}`);

  try {
    let song = await songGen.generate(job);
    if (cfg.voice.enabled && cfg.voice.autoConvert) {
      try {
        await sender.send(chat, { bubbles: [pick(['快写好啦，正在顺一遍旋律～', '歌差不多了，就差最后一点～'])] }).catch(() => {});
        song = await voiceConvert.convert({
          audioPath: song.file,
          customModelUrl: cfg.voice.customModelUrl || undefined,
          voice: cfg.voice.rvcModel,
          pitch: cfg.voice.autoConvertPitch,
        });
      } catch (err) {
        logger.warn(`自动变声失败，发原始版本：${err.message}`);
      }
    }
    const title = job.title ? `《${job.title}》` : '新歌';
    const tookSec = Math.round((Date.now() - (job.startedAt || Date.now())) / 1000);
    const lead = tookSec > 120 ? `之前你让我写的${title}好了，听听看～` : `${title}写好啦，听听看～`;
    await sender.sendAudio(chat, song.file, `${title}-${song.seconds || 30}s.mp3`, lead, cfg.song.sendAsVoice ?? 'auto');
    memory.append(chat.key, 'assistant', `[我刚写了一首${title}并发给你了，音频文件]`, chat.title);
    lastSent.set(chat.key, { kind: 'song', title: job.title || '原创' });
    logMedia({ chatKey: chat.key, direction: 'out', kind: 'audio', name: `${title}.mp3`, title: job.title || '原创', detail: `${song.seconds || 30} 秒`, path: song.file });
  } catch (err) {
    logger.warn(`生成歌曲失败：${err.message}`);
    try {
      const hum = renderHum({ seconds: 20, tempo: cfg.music?.tempo, noise: cfg.music?.noise });
      await sender.send(chat, {
        bubbles: ['这次没生成出来，我先哼一段给你垫垫。'],
        voices: [{ file: hum.file, name: hum.name, hum: true }],
      });
    } catch {
      /* ignore */
    }
  } finally {
    activeSongs.delete(chat.key);
    endJob(songJid);
  }
}

/** 从本地曲库唱一首（点歌名 → 定位 → 截取 → 变声）。 */
async function startLibraryCover(chat, hit, { startPhrase = '', requestedSeconds = 0 } = {}) {
  lastCover.set(chat.key, { kind: 'library', title: hit.title, startPhrase, seconds: requestedSeconds });

  let startSec = 0;
  let matchedText = '';
  if (startPhrase && aligner.enabled) {
    await sender.send(chat, { bubbles: [pick(['我去歌词里找一下那句～', '等我对一下歌词…'])] }).catch(() => {});
    try {
      const found = await aligner.findLineStart(hit.path, startPhrase);
      if (found) {
        startSec = found.start;
        matchedText = found.matched;
      }
    } catch (err) {
      logger.warn(`歌词定位失败：${err.message}`);
    }
  }
  logger.info(
    `曲库命中：${hit.artist} - ${hit.title}${startSec ? `（起点 ${startSec.toFixed(1)}s）` : ''}${requestedSeconds ? `（要 ${requestedSeconds} 秒）` : ''}`,
  );

  const target = requestedSeconds || (startSec > 0 ? 50 : (cfg.library.maxSeconds ?? 0));
  let src = hit.path;
  try {
    if (startSec > 0 || target > 0) {
      src = await cutAudioFrom(hit.path, startSec, target, { ffmpeg: cfg.media?.ffmpegPath, tag: 'song' });
    }
  } catch (err) {
    logger.warn(`截取失败，改用原文件：${err.message}`);
    src = hit.path;
  }
  const seconds = await probeDuration(src, { ffmpeg: cfg.media?.ffmpegPath });

  let opening = `找到《${hit.title}》啦～`;
  if (startSec) opening += `就从「${matchedText}」那句开始`;
  else if (startPhrase) opening += '没对上那句，从头唱啦';
  opening += pick(['，激情献唱中', '，那我开唱啦', '，马上安排']);
  if (seconds > 55) opening += '（这段有点长，发文件给你）';

  await sender.send(chat, { bubbles: [opening] }).catch(() => {});
  runCoverJob(chat, src, { title: hit.title, seconds, quietAck: true }).catch((err) => logger.warn(`点歌任务异常：${err.message}`));
}

/** 后台生成 PPT / Word，完成后发文件。 */
async function runOfficeJob(chat, job) {
  const controller = new AbortController();
  docJobs.set(chat.key, { controller, job });
  if (job.topic) lastDocTopic.set(chat.key, job.topic);
  try {
    const doc =
      job.kind === 'docx'
        ? await office.makeDocx({ topic: job.topic, sections: job.sections, signal: controller.signal })
        : job.kind === 'excel'
          ? await office.makeExcel({ topic: job.topic, rows: job.rows, columns: job.columns, signal: controller.signal })
          : await office.makePpt({ topic: job.topic, pages: job.pages, theme: job.theme, withImages: true, signal: controller.signal });
    await sender.sendFile(chat, doc.file, doc.name, pick(['做好啦，看看行不行～', '出炉了，你看看要不要改～']));
    memory.append(chat.key, 'assistant', `[我刚做好并发给你一份文件：${doc.name}]`, chat.title);
    logMedia({ chatKey: chat.key, direction: 'out', kind: 'doc', name: doc.name, path: doc.file });
  } catch (err) {
    if (err.name === 'AbortError' || /aborted|cancel/i.test(err.message)) {
      logger.info('文档任务已取消');
      return;
    }
    logger.warn(`生成文档失败：${err.message}`);
    await sender.send(chat, { bubbles: [pick(['这次没做出来，等会儿再试一次？', '文档卡住了，我再来一次好不好？'])] }).catch(() => {});
  } finally {
    docJobs.delete(chat.key);
  }
}

/** 白名单好友传话时，立刻私聊推给主人。 */
async function notifyOwnerRelay(item) {
  const ownerId = Number(cfg.access?.ownerQQ || cfg.access?.adminQQ?.[0] || 0);
  if (!ownerId) return false;
  const text = `【传话】${item.name || item.from}（${item.from}）：${item.text}`;
  await onebot.sendPrivate(ownerId, [{ type: 'text', data: { text } }]);
  logger.info(`已把传话直接推给主人：${item.from}`);
  return true;
}

/** 主人让带话时，立刻私聊发给指定好友。 */
async function notifyFriend(uin, text) {
  await onebot.sendPrivate(Number(uin), [{ type: 'text', data: { text } }]);
  logger.info(`已给 ${uin} 发送传话`);
}

/** 确保本地 faster-whisper 服务在跑（不在就拉起来）。 */
async function ensureLocalAsr() {
  const local = cfg.asr?.local;
  if (!local?.enabled) return false;
  if (await localAsrHealthy(local.url)) return true;
  const bin =
    local.pythonPath ||
    cfg.office?.pythonPath ||
    cfg.tts?.pythonPath ||
    process.env.PYTHON_PATH ||
    path.join(process.env.LOCALAPPDATA || '', 'AstrBot', 'backend', 'python', 'python.exe');
  if (!fs.existsSync(bin)) {
    logger.warn(`本地 ASR：找不到 python（${bin}）`);
    return false;
  }
  try {
    const child = spawn(bin, [path.join(ROOT, 'scripts', 'asr_server.py'), String(local.port || 8090)], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        HF_ENDPOINT: 'https://hf-mirror.com',
        HF_HUB_DISABLE_XET: '1',
        ASR_MODEL_SIZE: local.model || 'small',
      },
    });
    child.unref();
    logger.info('本地 ASR 服务启动中…');
    for (let i = 0; i < 50; i++) {
      await sleep(1200);
      if (await localAsrHealthy(local.url)) {
        logger.info('本地 ASR 就绪');
        return true;
      }
    }
  } catch (err) {
    logger.warn(`本地 ASR 启动失败：${err.message}`);
  }
  return false;
}

async function onMessage(event) {
  stats.received++;
  if (String(event.user_id) === String(onebot.selfId)) return;

  const { text, images, files, audios, videos, stickerCount, mentioned, quoteId } = extractMessage(event);
  const chat = chatOf(event);
  const isPrivate = event.message_type === 'private';
  const senderName = event.sender?.card || event.sender?.nickname || '';
  if (senderName) upsertContact(event.user_id, senderName);

  if (isPrivate && !allowedPrivate(event.user_id)) {
    stats.ignored++;
    logger.debug(`忽略未授权私聊 ${event.user_id}`);
    return;
  }
  if (!isPrivate && !allowedGroup(event.group_id)) {
    stats.ignored++;
    logger.debug(`忽略未授权群 ${event.group_id}`);
    return;
  }

  // 文档改需求：先停掉正在做的，再按新格式来
  const msgText = String(text || '');
  const stopDoc = /(别做|不要做|先不做|停|取消|别弄).{0,6}(ppt|幻灯片|word|文档|excel|表格)/.test(msgText) ||
    /(ppt|幻灯片).{0,6}(别做|不要|停|取消)/.test(msgText) ||
    /^(停|停下|别做了|取消|算了)$/.test(msgText.trim());
  if (stopDoc) {
    const cur = docJobs.get(chat.key);
    if (cur) {
      cur.controller.abort();
      docJobs.delete(chat.key);
      logger.info('收到取消指令，已中止文档任务');
    }
    if (/(word|docx|文档)/i.test(msgText) && /(改|换|还是|重新)/.test(msgText)) {
      const topic = lastDocTopic.get(chat.key) || extractDocTopic(msgText, 'docx') || '本周学习任务';
      trackJob(`文档：docx ${topic}`, runOfficeJob(chat, { kind: 'docx', topic, sections: 5 })).catch((err) =>
        logger.warn(`文档任务异常：${err.message}`),
      );
      await sender.send(chat, { bubbles: ['好，PPT 停了，改做 Word～'] });
      return;
    }
  }

  // 游戏：私聊里开了局就直接按规则处理，不走进普通聊天
  if (isPrivate && !String(text || '').trim().startsWith('/')) {
    const started = games.tryStart(chat.key, text);
    if (started) {
      await sender.send(chat, { bubbles: [started] });
      return;
    }
    const out = games.handle(chat.key, text);
    if (out?.reply) {
      await sender.send(chat, { bubbles: [out.reply] });
      return;
    }
    if (out?.prompt) {
      // 游戏进行中：直接交给模型扮演主持人，不经过点歌/文档/画图这些意图
      const gameReply = await brain.respond({
        chatKey: chat.key,
        title: chat.title,
        userText: `${text}\n\n${out.prompt}`,
        meta: { scene: '私聊', peerName: senderName },
      });
      await sender.send(chat, gameReply);
      return;
    }
  }

  // 私聊消息统一缓冲：连续发多条（文字/图片/文件/语音）合并成一次处理，只回一次
  if (isPrivate && !event.__batch && !String(text || '').trim().startsWith('/')) {
    enqueueEvent(chat.key, event);
    return;
  }

  let body = text;
  if (!isPrivate) {
    const hasWake = (cfg.chat.group.wakeWords ?? []).some((w) => w && text.includes(w));
    const addressed = (cfg.chat.group.replyOnAt && mentioned) || hasWake;
    if (!addressed) {
      const chance = cfg.chat.group.chanceReply ?? 0;
      if (!(chance > 0 && Math.random() < chance)) return;
      logger.info(`群 ${event.group_id} 随机接话`);
    } else if (hasWake) {
      body = stripWakeWord(body);
    }
    if (mentioned) body = stripWakeWord(body);
  }

  // 用户自己说的话：只用来判断意图（点歌/画图/文档…），
  // 后面会把文件正文、图片说明等拼进 body，那些内容不能触发点歌。
  const userSay = String(body || '');

  // 自动记笔记：行程、考试、承诺、偏好这类信息，直接写进长期记忆
  const noteHints = /(下周|这周|本周|明天|后天|周[一二三四五六日天]|考试|截止|ddl|deadline|proposal|presentation|\bpre\b|作业|论文|报告|会议|面试|约好|答应|提醒我|我喜欢|我讨厌|我住|我在准备|养了|生日)/i;
  if (
    noteHints.test(userSay) &&
    userSay.length >= 6 &&
    userSay.length <= 140 &&
    !/^https?:/i.test(userSay) &&
    !/^\/[a-z]/i.test(userSay)
  ) {
    const clean = userSay.replace(/\s+/g, ' ').trim().slice(0, 120);
    try {
      if (memory.addNote(chat.key, clean, chat.title)) logger.info(`自动记笔记：${clean.slice(0, 40)}`);
    } catch {
      /* ignore */
    }
  }

  // 自己没发图，但引用了一张图（常见的“看看这张”用法）
  let effectiveImages = images;

  // 以“文件”形式发来的图片（原图发送）：先下载成本地文件再交给视觉模型
  for (const img of effectiveImages) {
    if (!img?.fromFile) continue;
    if (img.url && /^https?:/i.test(img.url)) continue;
    try {
      const f = await fileReader.download(onebot, {
        name: img.name,
        file: img.file,
        file_id: img.fileId,
        url: img.url,
      });
      img.url = `file:///${f.path.replace(/\\/g, '/')}`;
      logger.info(`图片文件已下载：${f.name}（${Math.round((f.size || 0) / 1024)}KB）`);
      logMedia({ chatKey: chat.key, direction: 'in', kind: 'image', name: f.name, path: f.path });
    } catch (err) {
      logger.warn(`图片文件下载失败：${err.message}`);
    }
  }
  if (!effectiveImages.length && quoteId) {
    const quoted = await fetchQuoted(quoteId);
    if (quoted?.images?.length) {
      effectiveImages = quoted.images;
      if (!body) body = quoted.text;
      logger.info(`引用消息里带图，一起识别（${effectiveImages.length} 张）`);
    }
  }

  // 音频文件（.m4a/.mp3 等）：当成“刚发的音频”，翻唱时直接用
  const AUDIO_FILE_RE = /\.(mp3|m4a|wav|flac|ogg|aac|amr|opus|silk)$/i;
  const audioAttachment = (files || []).find((f) => AUDIO_FILE_RE.test(f.name || f.file || ''));
  if (audioAttachment) {
    try {
      const a = await fileReader.download(onebot, audioAttachment);
      const old = lastAudio.get(chat.key);
      if (old) prevAudio.set(chat.key, old);
      lastAudio.set(chat.key, { path: a.path, at: Date.now() });
      logger.info(`收到音频文件：${a.name}（${Math.round((a.size || 0) / 1024)}KB）`);
    } catch (err) {
      logger.warn(`音频文件下载失败：${err.message}`);
    }
  }

  // 文件消息：下载下来抽文字，塞进上下文；读不出来也要回应，不能装死
  if (files.length) {
    const chunks = [];
    for (const f of files.slice(0, 4)) {
      if (audioAttachment && f === audioAttachment) continue;
      const name = f.name || '文件';
      try {
        const r = await fileReader.read(onebot, f);
        if (r.ok && r.text) {
          chunks.push(`【对方发来的文件：${name}】\n${r.text.slice(0, 6000)}`);
        } else {
          chunks.push(`【对方发来的文件：${name}】（我读不出里面的文字：${r.error || '格式不支持'}）`);
        }
        // Word/PPT/Excel 里的图片也抽出来一起看
        if (/\.(docx|pptx|xlsx)$/i.test(name)) {
          const pics = await fileReader.extractImages(r);
          if (pics.length) {
            effectiveImages = [...effectiveImages, ...pics.map((p) => ({ file: p }))];
            chunks.push(`（文件里还有 ${pics.length} 张图，已经一起看了）`);
            logger.info(`从 ${name} 抽出 ${pics.length} 张图`);
          }
          logMedia({ chatKey: chat.key, direction: 'in', kind: 'doc', name, detail: `${r.chars || 0} 字 · ${pics.length} 图`, path: r.path, snippet: String(r.text || '').slice(0, 200) });
        } else {
          logMedia({ chatKey: chat.key, direction: 'in', kind: 'doc', name, detail: `${r.chars || 0} 字`, path: r.path, snippet: String(r.text || '').slice(0, 200) });
        }
      } catch (err) {
        chunks.push(`【对方发来的文件：${name}】（读取失败：${err.message}）`);
      }
    }
    body = [body, ...chunks].filter(Boolean).join('\n');
  }

  // 音频：下载留存；要翻唱就直接走变声，不进模型
  let audioNote = '';
  let downloadedAudio = '';
  if (audios.length) {
    try {
      const a = await fileReader.download(onebot, audios[0]);
      downloadedAudio = a.path;
      const old = lastAudio.get(chat.key);
      if (old) prevAudio.set(chat.key, old);
      lastAudio.set(chat.key, { path: a.path, at: Date.now() });
      logger.info(`收到音频：${a.name}（${Math.round((a.size || 0) / 1024)}KB）`);
      const audioSeconds = await probeDuration(a.path, { ffmpeg: cfg.media?.ffmpegPath }).catch(() => 0);
      logMedia({
        chatKey: chat.key,
        direction: 'in',
        kind: 'audio',
        name: a.name,
        detail: `${Math.round(audioSeconds)} 秒`,
        path: a.path,
      });
      if (audioSeconds > 30) {
        // 长音频多半是歌/音乐，不是说话，别硬转写（会转成乱码）
        audioNote = `[对方发来一段约 ${Math.round(audioSeconds)} 秒的音频/歌曲，没有转写]`;
      } else if (wantsCover(userSay)) {
        audioNote = '[对方发来一段音频/语音]';
      } else {
        await sender.send(chat, { bubbles: [pick(['我听听…', '稍等，我听一下～', '唔，让我听清…'])] }).catch(() => {});
        try {
          let asrSource = a.path;
          if (/\.silk$/i.test(a.path) || /\.silk$/i.test(a.name || '')) {
            try {
              asrSource = await silkToWav(a.path, { python: cfg.office?.pythonPath, tag: 'voice' });
              logger.info('SILK 语音已转成 wav');
            } catch (err) {
              logger.warn(`SILK 转码失败：${err.message}`);
            }
          }
          const asrPath = await toMp3(asrSource, { ffmpeg: cfg.media?.ffmpegPath, tag: 'voice' }).catch(() => asrSource);
          let transcript = '';
          // 优先用本地小模型（2~3 秒），不可用再走云端
          try {
            if (cfg.asr?.local?.enabled && (await localAsrHealthy(cfg.asr.local.url))) {
              transcript = (await localTranscribe(asrPath, { url: cfg.asr.local.url })).text;
              // 粤语：识别结果里出现粤语用字，就按粤语再认一遍
              if (transcript && /(嘅|咗|唔|係|佢|哋|乜|咁|喺|嚟|冇|畀|睇|啲|嗰)/.test(transcript)) {
                try {
                  const yue = await localTranscribe(asrPath, { url: cfg.asr.local.url, language: 'yue' });
                  if (yue.text && yue.text.length >= transcript.length * 0.6) {
                    transcript = yue.text;
                    logger.info('检测到粤语，已用粤语模型重认');
                  }
                } catch (err) {
                  logger.warn(`粤语重认失败：${err.message}`);
                }
              }
            }
          } catch (err) {
            logger.warn(`本地转写失败：${err.message}`);
          }
          if (!transcript) {
            try {
              transcript = await aligner.transcribeFast(asrPath);
            } catch (err) {
              logger.warn(`快速转写失败，改用逐字识别：${err.message}`);
              const words = await aligner.wordsFor(asrPath);
              transcript = words.map((w) => w.word).join('').replace(/\s+/g, '');
            }
          }
          transcript = String(transcript || '').trim();
          if (transcript) {
            try {
              transcript = OpenCC.Converter({ from: 'tw', to: 'cn' })(transcript);
            } catch {
              /* 转换失败就用原文 */
            }
          }
          if (transcript) {
            audioNote = `[对方语音转写] ${transcript}`;
            logger.info(`语音转写：${transcript.slice(0, 60)}`);
          } else {
            audioNote = '[对方发来一段语音，但没识别出内容]';
          }
        } catch (err) {
          audioNote = '[对方发来一段语音，转写失败，可以请他再说一遍]';
          logger.warn(`语音转写失败：${err.message}`);
        }
      }
    } catch (err) {
      audioNote = '（对方发来音频，但下载失败）';
      logger.warn(`音频下载失败：${err.message}`);
    }
  }

  // 视频：下载留存，要翻唱就从里面抽音轨
  let videoNote = '';
  let downloadedVideo = '';
  if (videos.length) {
    try {
      const v = await fileReader.download(onebot, videos[0]);
      downloadedVideo = v.path;
      lastVideo.set(chat.key, { path: v.path, at: Date.now() });
      videoNote = '[对方发来一段视频]';
      logger.info(`收到视频：${v.name}（${Math.round((v.size || 0) / 1024)}KB）`);
      logMedia({ chatKey: chat.key, direction: 'in', kind: 'video', name: v.name, path: v.path });
      try {
        const frame = await extractFrame(v.path, { ffmpeg: cfg.media?.ffmpegPath, tag: 'frame' });
        const caption = await brain.describeImages([{ file: frame }]);
        if (caption) {
          videoNote += ` 画面：${caption.replace('[对方发来的图片]', '').trim()}`;
          logger.info('视频画面已识别');
        }
      } catch (err) {
        logger.warn(`视频抽帧/识别失败：${err.message}`);
      }
    } catch (err) {
      videoNote = '（对方发来视频，但下载失败）';
      logger.warn(`视频下载失败：${err.message}`);
    }
  }

  // 点歌名：从本地曲库里找，找到就自动翻唱
  const requestedSeconds = /(翻唱|点歌|唱|听|只要)/.test(userSay) ? parseDuration(body) : 0;
  const coverReq = parseCoverRequest(userSay);
  const songQuery = coverReq.title;
  const correction = isCorrection(userSay);

  // 用户说“不是这首/不对”：换下一首或让他确认，别直接放弃
  if (correction) {
    const last = lastCover.get(chat.key);
    if (last?.kind === 'library') {
      const next = library.search(last.title, { limit: 3, excludeTitle: last.title });
      if (next.length) {
        await sender.send(chat, {
          bubbles: [`不是这首呀，那换成《${next[0].title}》${next[0].artist ? `（${next[0].artist}）` : ''}试试～`],
        }).catch(() => {});
        await startLibraryCover(chat, next[0], { startPhrase: last.startPhrase || '', requestedSeconds: last.seconds || 0 });
        return;
      }
      const all = library.search(last.title, { limit: 3 });
      if (all.length) {
        const names = all.map((h) => `${h.artist || '未知'}《${h.title}》`).slice(0, 3).join('、');
        await sender.send(chat, { bubbles: [`我搜到这些：${names}。你说的是哪一个？`] }).catch(() => {});
        return;
      }
    }
  }

  // “我怎么唱你就怎么唱/学我唱/照我这样唱”：让你模仿他的唱法，不是歌名
  const imitate = /(怎么唱你就怎么唱|我唱一句你唱一句|学我唱|照我(这样|那样)唱|跟着我唱|按我唱|模仿我|像我(这样|那样)唱|跟我唱)/.test(
    body,
  );
  if (imitate && !correction) {
    const rec = downloadedAudio
      ? { path: downloadedAudio, at: Date.now() }
      : lastAudio.get(chat.key) || prevAudio.get(chat.key);
    if (rec && Date.now() - rec.at < 60 * 60 * 1000) {
      trackJob('翻唱：学你唱', runCoverJob(chat, rec.path, { title: '学你唱' })).catch((err) =>
        logger.warn(`模仿翻唱异常：${err.message}`),
      );
      return;
    }
  }

  // 自己发了音频 + 说“翻唱”：默认唱他发的这段，不要跑去曲库（除非明确带书名号）
  if (downloadedAudio && /(翻唱|学我|照我|跟我唱)/.test(userSay) && !/[《》]/.test(userSay)) {
    trackJob('翻唱：你发的这段', runCoverJob(chat, downloadedAudio, { title: '你发的这段' })).catch((err) =>
      logger.warn(`翻唱当前音频异常：${err.message}`),
    );
    return;
  }

  // “翻唱我刚刚唱的/上面那段”：这不是歌名，直接用最近发来的音频
  const refersToRecent = /(我(刚|刚才|刚刚)|刚刚|刚才|上面|这段|那条|这版|我的声音)/.test(userSay);
  if (coverReq.coverIntent && refersToRecent && !correction) {
    const probe = songQuery ? library.search(songQuery, { limit: 1 }) : [];
    if (!probe.length) {
      const rec = lastAudio.get(chat.key) || prevAudio.get(chat.key);
      if (rec && Date.now() - rec.at < 60 * 60 * 1000) {
        trackJob('翻唱：刚刚那段', runCoverJob(chat, rec.path, { title: '刚刚那段' })).catch((err) =>
          logger.warn(`翻唱刚发的音频失败：${err.message}`),
        );
        return;
      }
    }
  }

  // “这是你唱的你还记得吗”= 回忆，不是点歌
  const isRecallQuestion =
    /(你还记得|记得吗|记不记得|是不是你(唱|发)|你唱过|你发过|你刚才唱|这不是你唱的)/.test(userSay) &&
    !/(唱一|唱首|翻唱|点歌|再来|唱给我)/.test(userSay);
  if (isRecallQuestion) {
    const sent = lastSent.get(chat.key);
    if (sent?.title) {
      body += `\n[系统提示：你刚给对方发过${sent.kind === 'song' ? '一首原创歌' : '一段翻唱'}《${sent.title}》，他是在问你记不记得，别当成点歌]`;
    }
  }

  if (songQuery && coverReq.coverIntent && library.enabled && !isRecallQuestion) {
    let hits = library.search(songQuery, { limit: 5, artist: coverReq.artist });
    if (!hits.length && coverReq.artist) hits = library.search(songQuery, { limit: 5 });
    if (!hits.length) {
      const short = songQuery.split(/[\s，,。.!！?？]/)[0];
      if (short && short !== songQuery) hits = library.search(short, { limit: 5, artist: coverReq.artist });
    }
    if (hits.length) {
      await startLibraryCover(chat, hits[0], { startPhrase: coverReq.startPhrase, requestedSeconds });
      return;
    }
    if (songQuery.length >= 2) {
      const songLabel = coverReq.artist ? `${coverReq.artist}的《${songQuery}》` : `《${songQuery}》`;
      if (coverReq.artist) {
        const byArtist = library.search(coverReq.artist, { limit: 5 });
        const names = byArtist.map((h) => `《${h.title}》`).slice(0, 3);
        if (names.length) {
          await sender.send(chat, {
            bubbles: [`${songLabel}我这儿没有呀。不过${coverReq.artist}的我存了${names.join('、')}，想听哪首？`],
          }).catch(() => {});
          return;
        }
      }
      const lines = [
        `${songLabel}我翻了一圈没翻到…要不换一首？或者我给你写一首同味道的原创？`,
        `唔，${songLabel}不在我曲库里诶。要不换一首？或者我现写一首类似的给你听？`,
        `找了一圈，${songLabel}没存下来，有点可惜～要不我给你写一首同味道的原创？`,
        `${songLabel}我暂时唱不了，曲库没这首。要不我给你写一首相似的？`,
        `哎，${songLabel}这首我这儿还没有。你先换一首？或者我现写一首给你？`,
      ];
      await sender.send(chat, { bubbles: [pick(lines)] }).catch(() => {});
      return;
    }
  } else if (coverReq.startPhrase && library.enabled) {
    // 只说了“从某句开始唱”、没带歌名：接着上一首
    const last = lastCover.get(chat.key);
    if (last?.kind === 'library') {
      const hits = library.search(last.title, { limit: 3 });
      if (hits.length) {
        await startLibraryCover(chat, hits[0], { startPhrase: coverReq.startPhrase, requestedSeconds });
        return;
      }
    }
  }

  // “再做一遍/重来/再来唱”：没带歌名时，重复上一次翻唱（音频优先）
  if (
    !songQuery &&
    /(再做一遍|再试一次|重来|再唱一次|重新唱|再来一遍|再做一次|再试一下|再来唱|再唱|继续唱|接着唱|还唱)/.test(userSay)
  ) {
    const last = lastCover.get(chat.key);
    if (last?.kind === 'library') {
      const hits = library.search(last.title, { limit: 3 });
      if (hits.length) {
        await startLibraryCover(chat, hits[0], { startPhrase: last.startPhrase || '', requestedSeconds: last.seconds || 0 });
        return;
      }
    } else if (last?.kind === 'audio' && last.path && fs.existsSync(last.path)) {
      trackJob('翻唱：再来一遍', runCoverJob(chat, last.path, { seconds: last.seconds || 0, title: '刚刚那段' })).catch((err) =>
        logger.warn(`重试变声异常：${err.message}`),
      );
      return;
    } else {
      const rec = lastAudio.get(chat.key);
      if (rec && Date.now() - rec.at < 60 * 60 * 1000) {
        trackJob('翻唱：刚刚那段', runCoverJob(chat, rec.path, { title: '刚刚那段' })).catch((err) =>
          logger.warn(`继续翻唱异常：${err.message}`),
        );
        return;
      }
    }
  }

  if (wantsCover(userSay) && !isRecallQuestion) {
    let src = downloadedAudio;
    let fromVideo = false;
    if (!src && downloadedVideo) {
      try {
        await sender.send(chat, { bubbles: ['收到视频，我先把音轨抽出来～'] }).catch(() => {});
        src = await extractAudio(downloadedVideo, { ffmpeg: cfg.media?.ffmpegPath, tag: 'fromvideo' });
        fromVideo = true;
      } catch (err) {
        logger.warn(`抽音轨失败：${err.message}`);
        await sender.send(chat, { bubbles: [`这个视频里没找到能用的声音：${err.message.slice(0, 60)}`] });
        return;
      }
    }

    if (!src) {
      const recentAudio = lastAudio.get(chat.key);
      if (recentAudio && Date.now() - recentAudio.at < 30 * 60 * 1000) src = recentAudio.path;
    }
    if (!src) {
      const recentVideo = lastVideo.get(chat.key);
      if (recentVideo && Date.now() - recentVideo.at < 30 * 60 * 1000) {
        try {
          src = await extractAudio(recentVideo.path, { ffmpeg: cfg.media?.ffmpegPath, tag: 'fromvideo' });
          fromVideo = true;
        } catch (err) {
          logger.warn(`抽音轨失败：${err.message}`);
        }
      }
    }

    if (!src) {
      await sender.send(chat, { bubbles: ['先发一段语音、一个视频或 mp3 给我，我才能帮你变声呀。'] });
      return;
    }
    if (requestedSeconds > 0) {
      try {
        src = await trimAudio(src, requestedSeconds, { ffmpeg: cfg.media?.ffmpegPath, tag: 'cut' });
      } catch (err) {
        logger.warn(`裁剪失败：${err.message}`);
      }
    }
    const seconds = await probeDuration(src, { ffmpeg: cfg.media?.ffmpegPath });
    lastCover.set(chat.key, { kind: 'audio', path: src, seconds: requestedSeconds || 0 });
    logger.info(`开始变声（来源：${fromVideo ? '视频音轨' : '音频'}，约 ${Math.round(seconds)} 秒）`);
    runCoverJob(chat, src, { seconds }).catch((err) => logger.warn(`变声任务异常：${err.message}`));
    return;
  }

  if (audioNote) body = [body, audioNote].filter(Boolean).join('\n');
  if (videoNote) body = [body, videoNote].filter(Boolean).join('\n');

  // 问“写好了吗”时告诉模型真实状态，避免它继续演
  if (/(写好了吗|唱好了吗|写完了吗|写好了没|唱好了没|好了吗)/.test(userSay)) {
    const active = activeSongs.get(chat.key);
    body += active
      ? '\n[系统提示：这首歌确实还在生成中，还没好，可以安抚对方再等等]'
      : '\n[系统提示：目前并没有在生成歌曲，别装作在写；可以问对方想听什么，或直接开始写]';
  }

  // 主人来了：把别人托她传的话带进上下文
  let relayIds = [];
  const ownerId = String(cfg.access?.ownerQQ || cfg.access?.adminQQ?.[0] || '');
  if (isPrivate && ownerId && String(event.user_id) === ownerId) {
    const pending = peekPending().slice(0, 5);
    if (pending.length) {
      const lines = pending.map((m) => `- ${m.name || m.from}（${m.from}）：${m.text}`);
      body = `【系统提示：下面这些是别人托我转告你的话，回复时用口语自然转述，说明是谁说的，不要用列表】\n${lines.join('\n')}\n\n${body}`;
      relayIds = pending.map((m) => m.id);
      logger.info(`有 ${pending.length} 条传话要转告主人`);
    }
  }

  if (!body && !effectiveImages.length) return;
  if (rateLimited(chat.key)) {
    logger.warn(`${chat.key} 触发频率限制，跳过`);
    return;
  }

  const senderInfo = event.sender ?? {};
  const peerName = String(senderInfo.card || senderInfo.nickname || event.user_id);
  const meta = {
    scene: isPrivate ? '私聊' : '群聊',
    peerName: isPrivate ? peerName : `${peerName}（群友）`,
    groupName: isPrivate ? '' : await groupName(event.group_id),
  };

  const noAdminConfigured = (cfg.access.adminQQ ?? []).length === 0;
  if (isPrivate && body.startsWith('/') && (isAdmin(event.user_id) || noAdminConfigured)) {
    const reply = await handleCommand(chat, userSay);
    if (reply) await sender.send(chat, { bubbles: [reply] });
    return;
  }

  await runSerial(chat.key, async () => {
    try {
      logger.info(`收到 ${chat.key}：${body.slice(0, 60)}${effectiveImages.length ? ` [图片x${effectiveImages.length}]` : ''}`);
      const isOwnerChat = chat.key === `private:${cfg.access?.ownerQQ || ''}`;
      if (isOwnerChat && /(我的世界|minecraft|mc|游戏里|服务器)/i.test(userSay) && minecraft?.online) {
        try {
          body += `\n\n${MC_KNOWLEDGE}\n${mcStatusText(minecraft.snapshot())}`;
        } catch {
          /* ignore */
        }
      }
      // 游戏动态只给主人看，避免其他聊天对象看到主人在 MC 的坐标与活动
      const mcDigest = isOwnerChat ? formatMcDigest() : '';
      if (mcDigest) body += `\n\n${mcDigest}`;
      const mediaDigest = formatMediaDigest(chat.key);
      if (mediaDigest) body += `\n\n${mediaDigest}`;
      let result = await brain.respond({
        chatKey: chat.key,
        title: isPrivate ? `私聊 ${peerName}` : meta.groupName || `群 ${event.group_id}`,
        userText: body,
        images: effectiveImages,
        meta,
        onProgress: async (ev) => {
          if (ev.type === 'draw_start') {
            const ack = ['等我一下，我画给你。', '好，我这就画，稍等一下。', '唔，给我一点时间，马上画。'];
            await sender.send(chat, { bubbles: [ack[Math.floor(Math.random() * ack.length)]] });
          }
        },
      });
      // 兜底：对方让唱歌、模型却没哼，就替它补一段旋律
      if (wantsSing(userSay) && !(result.voices ?? []).length) {
        try {
          const m = cfg.music || {};
          const min = m.minSeconds ?? 18;
          const max = Math.max(min, m.maxSeconds ?? 30);
          const seconds = min + Math.floor(Math.random() * (max - min + 1));
          const hum = renderHum({ seconds, tempo: m.tempo, noise: m.noise });
          result = { ...result, voices: [...(result.voices ?? []), { file: hum.file, name: hum.name, hum: true }] };
          logger.info(`模型没哼歌，兜底补了一段 ${seconds} 秒旋律`);
        } catch (err) {
          logger.warn(`兜底哼唱失败：${err.message}`);
        }
      }

      // 兜底：对方要表情包（或发了表情包来斗图）、模型却没发，就替它补一张
      const wantSticker = wantsSticker(userSay) || stickerCount > 0;
      if (wantSticker && tools.stickerCats.length && !(result.images ?? []).some((i) => i.sticker)) {
        const category = pickStickerCategory(userSay);
        const ctx = { chatKey: chat.key, images: [], voices: [], memory };
        await tools.run('send_sticker', { category }, ctx);
        if (ctx.images.length) {
          logger.info(`模型没发表情包，兜底补了一张（${category}）`);
          result = { ...result, images: [...(result.images ?? []), ...ctx.images] };
        }
      }
      // 对方要“发条语音/说句话”，但模型没调 send_voice：用回复正文合成一条语音补上（必须在发送前）
      const wantsVoice = /(发条?语音|来条?语音|说句话|说句|用语音|语音说|发语音)/.test(userSay);
      if (wantsVoice && !(result.voices ?? []).length && cfg.tts?.enabled && tts) {
        const spoken = (result.bubbles ?? [])
          .join('，')
          .replace(/（[^）]*）/g, '')
          .replace(/\([^)]*\)/g, '')
          .slice(0, 120);
        if (spoken) {
          try {
            const audio = await tts.synthesize(spoken);
            result = { ...result, voices: [{ ...audio, fallback: true }] };
            logger.info('模型没发语音，已按回复内容补一条语音');
          } catch (err) {
            logger.warn(`补语音失败：${err.message}`);
          }
        }
      }

      // 兜底：对方要画图，模型却没调 draw_image
      if (wantsDraw(userSay) && !(result.images ?? []).length) {
        try {
          const dctx = { chatKey: chat.key, images: [], voices: [], memory };
          await tools.run('draw_image', { prompt: extractDrawPrompt(userSay) }, dctx);
          if (dctx.images.length) {
            result = { ...result, images: [...(result.images ?? []), ...dctx.images] };
            logger.info('模型没画图，兜底补了一张');
          }
        } catch (err) {
          logger.warn(`兜底画图失败：${err.message}`);
        }
      }

      // 兜底：对方要视频，模型没调 fetch_video，就自己去找一段
      if (wantsVideoRequest(userSay) && !(result.videos ?? []).length) {
        const q = extractVideoQuery(userSay);
        try {
          const list = await searchBili(q, 10);
          const pick = pickVideo(list, 300);
          if (pick) {
            const py = findPython(cfg.office?.pythonPath || cfg.tts?.pythonPath || cfg.tts?.pythonPath || '');
            const f = await downloadBili(pick.bvid, py);
            result = { ...result, videos: [{ file: f.file, name: videoFileName(pick.title), title: pick.title }] };
            logger.info(`模型没发起视频，兜底下载：${pick.title}`);
          }
        } catch (err) {
          logger.warn(`兜底找视频失败：${err.message}`);
        }
      }

      // 兜底：说了“翻唱/变声/用我刚唱的”，但模型没真的发起翻唱
      if (/(翻唱|变声|唱成|用我(刚|刚才)?(唱|录|发)的)/.test(userSay) && !(result.voices ?? []).length) {
        const rec = prevAudio.get(chat.key) || lastAudio.get(chat.key);
        if (rec && Date.now() - rec.at < 15 * 60 * 1000) {
          trackJob('翻唱：刚刚那段', runCoverJob(chat, rec.path, { title: '刚刚那段' })).catch((err) =>
            logger.warn(`自动翻唱异常：${err.message}`),
          );
          logger.info('模型没发起翻唱，兜底用刚发的音频开唱');
        }
      }

      await sender.send(chat, result, { quoteId: isPrivate ? event.message_id : undefined });
      if (relayIds.length) markDelivered(relayIds);
      for (const v of result.videos ?? []) {
        sender
          .sendVideo(chat, v.file, v.name, pick(['视频来啦～', '找到啦，发你看看', '给你搬过来了～']))
          .then(() => logMedia({ chatKey: chat.key, direction: 'out', kind: 'video', name: v.name, title: v.title || '', path: v.file }))
          .catch((err) => logger.warn(`发送视频失败：${err.message}`));
      }
      for (const job of result.songs ?? []) {
        trackJob(`写歌：${job.title || '新歌'}`, runSongJob(chat, job)).catch((err) => logger.warn(`歌曲任务异常：${err.message}`));
      }
      // 兜底：对方明确要 PPT/Word/Excel，模型却没调工具，就替它排队生成
      // 只是“提到/回忆某个文档”不算，别自作主张做文件
      const docKind = wantsDocCreation(userSay) ? wantDocType(userSay) : '';
      if (docKind && !(result.documents ?? []).length) {
        const topic = extractDocTopic(body, docKind) || body.replace(/\[[^\]]*\]/g, '').trim().slice(0, 60);
        if (topic) {
          result = {
            ...result,
            documents: [
              { kind: docKind, topic, pages: 12, theme: cfg.office?.theme || 'history', sections: 5, rows: 10, columns: 5 },
            ],
          };
          logger.info(`模型没调文档工具，兜底生成 ${docKind}：${topic}`);
        }
      }

      for (const job of result.documents ?? []) {
        trackJob(`文档：${job.kind} ${job.topic || ''}`, runOfficeJob(chat, job)).catch((err) => logger.warn(`文档任务异常：${err.message}`));
      }

      // 兜底：嘴上答应“这就唱/稍等两分钟”，但实际没调 sing_song，就替它真的写一首
      const said = (result.bubbles ?? []).join('');
      const promised =
        /(这就唱|唱给你|马上唱|写一首|写首歌|给你写|我写|这就写|在写|正在写|马上写|编一首|谱一首)/.test(said) ||
        (/(写|唱|编|谱)/.test(said) && /(歌|曲|段|首)/.test(said) && /(稍等|等我|一会儿|马上|很快|几分钟)/.test(said));
      if (!(result.songs?.length) && songGen.enabled && promised) {
        const theme = body.replace(/\[[^\]]*\]/g, '').trim().slice(-80) || '海边的小鲸鱼';
        const lyrics = await writeLyrics(theme);
        if (lyrics) {
          logger.info('模型口头答应唱歌但没调工具，自动补一首');
          runSongJob(chat, {
            lyrics,
            style: 'gentle pop, soft female vocal, warm, acoustic',
            title: theme.slice(0, 20) || '给你的歌',
            seconds: cfg.song.defaultSeconds || 30,
          }).catch((err) => logger.warn(`补歌任务异常：${err.message}`));
        }
      }
      stats.replied++;
    } catch (err) {
      stats.errors++;
      logger.error(`处理消息失败：${err.stack || err.message}`);
      const netErr = /fetch failed|timeout|ECONNRESET|EAI_AGAIN|network|socket/i.test(err.message || '');
      if (netErr) {
        const key = chat.key;
        if (Date.now() - (lastNetNotice.get(key) || 0) > 60000) {
          lastNetNotice.set(key, Date.now());
          await sender.send(chat, { bubbles: ['网有点卡，我缓一下，你再说一句？'] }).catch(() => {});
        }
      }
      const admin = Number(cfg.access.adminQQ?.[0] ?? 0);
      if (admin) {
        try {
          await onebot.sendPrivate(admin, [{ type: 'text', data: { text: `出错了：${err.message}` } }]);
        } catch {
          /* 发不出去就只写日志 */
        }
      }
    }
  });
}

// ---------- 加好友 / 拉群 ----------

async function onRequest(event) {
  try {
    const uid = Number(event.user_id ?? 0);
    if (event.request_type === 'friend') {
      if (!cfg.access.autoAcceptFriend) {
        logger.info(`收到好友申请（${uid}${event.comment ? `，附言：${event.comment}` : ''}），自动通过已关闭`);
        return;
      }
      await onebot.call('set_friend_add_request', { flag: event.flag, approve: true }, 10000);
      logger.info(`已自动通过好友申请：${uid}${event.comment ? `（附言：${event.comment}）` : ''}`);
      if (cfg.access.greeting) {
        await sleep(800);
        await onebot.sendPrivate(uid, [{ type: 'text', data: { text: cfg.access.greeting } }]);
      }
      return;
    }
    if (event.request_type === 'group') {
      if (!cfg.access.autoAcceptGroupInvite) {
        logger.info(`收到入群邀请（群 ${event.group_id}），自动通过已关闭`);
        return;
      }
      await onebot.call(
        'set_group_add_request',
        { flag: event.flag, sub_type: event.sub_type || 'invite', approve: true },
        10000,
      );
      logger.info(`已自动通过入群邀请：群 ${event.group_id}`);
    }
  } catch (err) {
    logger.warn(`处理好友/入群申请失败：${err.message}`);
  }
}

onebot.on('request', (event) => {
  onRequest(event).catch((err) => logger.warn(`好友申请处理异常：${err.message}`));
});

onebot.on('message', (event) => {
  onMessage(event).catch((err) => logger.error(`消息处理异常：${err.stack || err.message}`));
});

onebot.on('ready', ({ selfId, nickname }) => {
  logger.info(`机器人就绪：${nickname}（${selfId}）`);
  ensureLocalAsr().catch(() => {});
  if (cfg.qzone?.enabled) {
    if (!qzone) {
      qzone = new Qzone({
        onebot,
        cfg: cfg.qzone,
        llm,
        imageGen,
        logger: logger.child('qzone'),
        selfId,
        persona: readPersona(),
        memory,
        journal: actionJournal,
      });
      qzone.startAuto();
      tools = createTools({ cfg, llm, imageGen, tts, songGen, qzone, office, minecraft, relayNotify: notifyOwnerRelay, friendNotify: notifyFriend, jobTracker: { begin: beginJob, end: endJob }, logger: logger.child('tools') });
    } else {
      qzone.updateConfig(cfg.qzone);
    }
  }
});

onebot.on('status', () => {
  /* 控制台通过 /api/status 读取 */
});

// ---------- 配置热更新 ----------

async function applyConfig(rawPatch) {
  const patch = structuredClone(rawPatch ?? {});
  // 控制台回传的是打码后的密钥，原样返回时不要覆盖真实值
  if (patch?.llm?.apiKey && patch.llm.apiKey.includes('••••')) delete patch.llm.apiKey;
  if (patch?.onebot?.accessToken && patch.onebot.accessToken.includes('••••')) delete patch.onebot.accessToken;
  if (patch?.console?.token && patch.console.token.includes('••••')) delete patch.console.token;
  if (patch?.image?.apiKey && patch.image.apiKey.includes('••••')) delete patch.image.apiKey;
  if (patch?.song?.token && patch.song.token.includes('••••')) delete patch.song.token;

  const next = deepMerge(cfg, patch);
  const oldWs = cfg.onebot.wsUrl;
  const oldToken = cfg.onebot.accessToken;

  Object.assign(cfg, next);
  applyEnvOverrides(cfg);

  // 落盘时不要把环境变量里的密钥写回 config.json
  const disk = structuredClone(cfg);
  if (disk.llm) disk.llm.apiKey = '';
  if (disk.image) disk.image.apiKey = '';
  if (disk.song) disk.song.token = '';
  if (disk.voice) disk.voice.token = '';
  if (disk.onebot) disk.onebot.accessToken = '';
  if (disk.console) disk.console.token = '';
  saveConfig(disk);
  llm.updateConfig(cfg.llm);
  brain.visionModel = cfg.llm.visionModel;
  imageGen.updateConfig(cfg.image);
  tts.updateConfig(cfg.tts);
  songGen.updateConfig(cfg.song);
  voiceConvert.updateConfig({ ...cfg.voice, token: cfg.voice.token || cfg.song.token });
  library.updateConfig(cfg.library);
  aligner.updateConfig({ ...cfg.asr, token: cfg.asr.token || cfg.song.token });
  qzone?.updateConfig(cfg.qzone);
  fileReader.updateConfig({ pythonPath: cfg.tts.pythonPath });
  brain.updateConfig(cfg.chat);
  memory.updateConfig(cfg.chat);
  sender.updateConfig(cfg.chat);
  tools = createTools({ cfg, llm, imageGen, tts, songGen, qzone, office, minecraft, relayNotify: notifyOwnerRelay, friendNotify: notifyFriend, jobTracker: { begin: beginJob, end: endJob }, logger: logger.child('tools') });
  brain.tools = tools;
  if (cfg.llm.maxTokens) llm.cfg.maxTokens = cfg.llm.maxTokens;

  if (cfg.onebot.wsUrl !== oldWs || cfg.onebot.accessToken !== oldToken) {
    onebot.wsUrl = cfg.onebot.wsUrl;
    onebot.accessToken = cfg.onebot.accessToken;
    onebot.stop();
    setTimeout(() => onebot.start(), 300);
  }
  logger.info('配置已更新');
  return { ok: true };
}

function status() {
  const s = onebot.status();
  return {
    onebot: s,
    llm: { model: cfg.llm.model, baseUrl: cfg.llm.baseUrl, hasKey: Boolean(cfg.llm.apiKey), stats: llm.stats },
    stats: { ...stats, uptimeMs: Date.now() - stats.startedAt, jobs: busyList() },
    personaChars: readPersona().length,
    botName: cfg.bot.name,
    image: { enabled: cfg.image.enabled, provider: cfg.image.provider },
    song: { enabled: songGen.enabled, model: cfg.song.model },
    voice: { enabled: voiceConvert.enabled, model: cfg.voice.model, rvcModel: cfg.voice.rvcModel },
    library: {
      enabled: library.enabled,
      dir: cfg.library.dir,
      tracks: (library.ensureScanned(), library.tracks.length),
    },
    asr: { enabled: aligner.enabled },
    office: { enabled: true, theme: cfg.office?.theme || 'history' },
    qzone: {
      enabled: Boolean(qzone?.enabled),
      autoPost: Boolean(cfg.qzone?.autoPost),
      lastPostAt: qzone?.state?.lastPostAt || 0,
    },
    tts: { enabled: cfg.tts.enabled, voice: tts.voice },
    stickerCats: tools.stickerCats,
    sessions: memory.list().slice(0, 50),
  };
}

function previewImages(images) {
  return images
    .filter((img) => img.file && fs.existsSync(img.file))
    .slice(0, 4)
    .map((img) => {
      const buf = fs.readFileSync(img.file);
      const ext = img.file.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
      return { name: img.name, dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` };
    });
}

const consoleServer = new ConsoleServer({
  cfg,
  logger,
  hooks: {
    status,
    getPersona: () => readPersona(),
    setPersona: (text) => writePersona(text),
    listSessions: () => memory.list(),
    getSession: (key) => memory.get(key),
    deleteSession: (key) => memory.remove(key),
    logs: (n) => logger.tail(n),
    reconnect: () => {
      onebot.stop();
      setTimeout(() => onebot.start(), 300);
    },
    applyConfig,
    testChat: async (text) => {
      const result = await brain.respond({
        chatKey: 'console:test',
        title: '控制台测试',
        userText: text,
        images: [],
        meta: { scene: '控制台测试', peerName: '控制台' },
      });
      return {
        bubbles: result.bubbles,
        images: previewImages(result.images),
        ms: result.ms,
        toolCalls: result.toolCalls,
      };
    },
  },
});

// ---------- 启动 ----------

logger.info('==========================================');
logger.info(`  小鲸鱼 QQ 机器人启动（${cfg.bot.name}）`);
logger.info(`  模型：${cfg.llm.model}  出图：${cfg.image.enabled ? cfg.image.provider : '关闭'}  语音：${cfg.tts.enabled ? tts.voice : '关闭'}`);
logger.info('==========================================');

onebot.start();
consoleServer.start();

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info(`收到 ${signal}，正在退出…`);
  onebot.stop();
  consoleServer.stop();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error(`未处理的 Promise 异常：${err?.stack || err}`));
process.on('uncaughtException', (err) => logger.error(`未捕获异常：${err?.stack || err}`));

export { cfg, logger };
