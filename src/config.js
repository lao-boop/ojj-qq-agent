import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.QQBOT_DATA ? path.resolve(process.env.QQBOT_DATA) : path.join(ROOT, 'data');
export const PERSONA_PATH = path.join(DATA_DIR, 'persona.md');
export const CONFIG_PATH = process.env.QQBOT_CONFIG
  ? path.resolve(process.env.QQBOT_CONFIG)
  : path.join(ROOT, 'config.json');
export const EXAMPLE_CONFIG_PATH = path.join(ROOT, 'config.example.json');

/** 读取 .env（没有也不报错），只在进程环境里没有同名变量时写入。 */
function loadEnvFile() {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || !m[2] || /^#/.test(line)) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch {
    /* 没有 .env 就跳过 */
  }
}
loadEnvFile();

/** 用环境变量覆盖配置里的密钥；config.json 可以只留空字符串。 */
export function applyEnvOverrides(cfg) {
  const env = process.env;
  if (env.DEEPSEEK_API_KEY) cfg.llm.apiKey = env.DEEPSEEK_API_KEY;
  if (env.DEEPSEEK_BASE_URL) cfg.llm.baseUrl = env.DEEPSEEK_BASE_URL;
  if (env.REPLICATE_API_TOKEN) {
    cfg.image.apiKey = env.REPLICATE_API_TOKEN;
    cfg.song.token = env.REPLICATE_API_TOKEN;
    cfg.voice.token = env.REPLICATE_API_TOKEN;
    if (cfg.asr) cfg.asr.token = env.REPLICATE_API_TOKEN;
  }
  if (env.ONEBOT_ACCESS_TOKEN) cfg.onebot.accessToken = env.ONEBOT_ACCESS_TOKEN;
  if (env.ONEBOT_WS_URL) cfg.onebot.wsUrl = env.ONEBOT_WS_URL;
  if (env.CONSOLE_TOKEN) cfg.console.token = env.CONSOLE_TOKEN;
  return cfg;
}

export const DEFAULTS = {
  bot: { name: '小鲸鱼' },
  onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', httpUrl: '' },
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-v4-pro',
    visionModel: 'deepseek-flash',
    helperModel: 'deepseek-flash',
    temperature: 1.15,
    maxTokens: 900,
    timeoutMs: 90000,
  },
  chat: {
    privateAlwaysReply: true,
    maxBubbles: 3,
    splitDelayMs: [500, 1600],
    firstDelayMs: [400, 1200],
    historyTurns: 60,
    storeAllTurns: true,
    retrieval: true,
    recallLimit: 10,
    summaryTriggerChars: 9000,
    group: {
      replyOnAt: true,
      wakeWords: ['小鲸鱼', '鲸鱼', '小鱼'],
      chanceReply: 0.03,
      minIntervalMs: 4000,
    },
    rateLimit: { perChatPerMinute: 12 },
  },
  access: {
    mode: 'whitelist',
    adminQQ: [],
    ownerQQ: '',
    privateAllow: [],
    groupAllow: [],
    allowAllWhenEmpty: false,
    autoAcceptFriend: true,
    autoAcceptGroupInvite: false,
    greeting: '嗨，我是小鲸鱼～好友申请过啦。有事随时说，没事也可以来聊两句。',
  },
  image: {
    enabled: true,
    provider: 'pollinations',
    baseUrl: 'https://image.pollinations.ai/prompt/',
    apiBase: '',
    apiKey: '',
    model: '',
    defaultSize: 'square',
    timeoutMs: 90000,
    cooldownMs: 45000,
    maxPromptChars: 400,
    removeWatermark: true,
  },
  tts: {
    enabled: true,
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    maxChars: 120,
    timeoutMs: 30000,
    pythonPath: '',
  },
  music: {
    minSeconds: 18,
    maxSeconds: 30,
    tempo: 84,
    noise: 0,
  },
  song: {
    enabled: true,
    token: '',
    model: 'fishaudio/ace-step-1.5',
    defaultSeconds: 30,
    maxSeconds: 60,
    timeoutMs: 300000,
    dailyLimit: 5,
    sendAsVoice: 'auto',
  },
  voice: {
    enabled: true,
    token: '',
    model: 'zsxkib/realistic-voice-cloning',
    rvcModel: 'Drake',
    pitchChange: 'no-change',
    customModelUrl: '',
    outputFormat: 'mp3',
    timeoutMs: 300000,
    dailyLimit: 10,
    autoConvert: false,
    autoConvertPitch: 'no-change',
    sendAsVoice: true,
  },
  console: { enabled: true, host: '127.0.0.1', port: 3010, token: '' },
  log: { level: 'info', file: true },
  media: { ffmpegPath: '' },
  mc: { username: 'Xiaojingyu', host: '127.0.0.1', port: 25565, version: '26.1', ownerName: '' },
  office: { pythonPath: '', theme: 'history', model: 'deepseek-flash', maxImages: 8, imagesPerDeck: 0, imageDelayMs: 12000 },
  relay: { enabled: true, allow: [], dailyLimit: 5, maxLen: 200 },
  library: { enabled: true, dir: 'D:\\无损音乐', maxSeconds: 0 },
  asr: {
    enabled: true,
    token: '',
    model: 'victor-upmeet/whisperx',
    local: { enabled: true, url: 'http://127.0.0.1:8090', port: 8090, model: 'small', pythonPath: '' },
  },
  qzone: {
    enabled: true,
    autoPost: true,
    intervalHours: 6,
    dailyLimit: 2,
    withImage: true,
    replyComments: true,
    pollMinutes: 10,
    ugcRight: 1,
  },
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isObject(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function ensureDirs() {
  for (const dir of [
    DATA_DIR,
    path.join(DATA_DIR, 'sessions'),
    path.join(DATA_DIR, 'images'),
    path.join(DATA_DIR, 'logs'),
    path.join(DATA_DIR, 'stickers'),
  ]) {
    // 目录可能是软链（表情包指向 AstrBot），权限异常时不要让整个程序起不来
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 跳过，后面用到时再容错 */
    }
  }
  if (!fs.existsSync(PERSONA_PATH)) {
    try {
      const seed = path.join(ROOT, 'assets', 'persona.default.md');
      fs.mkdirSync(path.dirname(PERSONA_PATH), { recursive: true });
      fs.copyFileSync(seed, PERSONA_PATH);
    } catch {
      /* ignore */
    }
  }
}

export function loadConfig() {
  ensureDirs();
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`config.json 解析失败：${err.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, fileCfg);
  applyEnvOverrides(cfg);
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

export function readPersona() {
  try {
    return fs.readFileSync(PERSONA_PATH, 'utf8');
  } catch {
    return '';
  }
}

export function writePersona(text) {
  fs.writeFileSync(PERSONA_PATH, text, 'utf8');
}
