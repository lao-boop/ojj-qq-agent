import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

/**
 * 模拟的 OneBot v11 服务端，用来在没有 QQ 的情况下把整条链路跑通。
 * 用法：node src/mock-onebot.js --port 3101 --qq 10001 --message "在吗"
 */
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 3101);
const userQQ = Number(args.qq ?? 10001);
const selfQQ = Number(args.self ?? 30001);
const groupId = Number(args.group ?? 90001);
const messages = String(args.message ?? '在吗').split('||');
const delay = Number(args.delay ?? 1500);
const autoGroup = args.group !== undefined && args['no-group'] !== 'true';
const imagePath = args.image ? path.resolve(String(args.image)) : '';

const receivedDir = path.join(DATA_DIR, 'received');
fs.mkdirSync(receivedDir, { recursive: true });

const wss = new WebSocketServer({ port, host: '127.0.0.1' });
let socket = null;
let msgId = 1000;
let scriptStarted = false;
const sentTexts = [];
const messageStore = new Map();

function broadcast(event) {
  const raw = JSON.stringify(event);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(raw);
  }
}

wss.on('connection', (ws) => {
  socket = ws;
  log(`OneBot 客户端已连接（ws://127.0.0.1:${port}）`);
  ws.on('message', (raw) => {
    let req;
    try {
      req = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { action, params = {}, echo } = req;
    let data = {};
    if (action === 'get_login_info') {
      data = { user_id: selfQQ, nickname: '小鲸鱼（mock）' };
    } else if (action === 'send_private_msg' || action === 'send_group_msg') {
      data = { message_id: ++msgId };
      handleOutgoing(action, params);
    } else if (action === 'get_group_info') {
      data = { group_id: params.group_id, group_name: '测试群' };
    } else if (action === 'get_msg') {
      data = messageStore.get(String(params.message_id)) ?? {};
    } else if (action === 'set_friend_add_request') {
      log(`← 机器人同意了好友申请（flag=${params.flag}, approve=${params.approve}）`);
      data = {};
    } else if (action === 'set_group_add_request') {
      log(`← 机器人同意了入群邀请（flag=${params.flag}）`);
      data = {};
    } else if (action === 'upload_private_file' || action === 'upload_group_file') {
      data = { file_id: `mock-file-${++msgId}` };
      handleOutgoingFile(params);
    }
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
  });
  ws.on('close', () => log('客户端断开'));
  if (!scriptStarted) {
    scriptStarted = true;
    setTimeout(() => runScript(), delay);
  }
});

function runScript() {
  messages.forEach((text, i) => {
    setTimeout(() => sendPrivate(text), i * 2000);
  });
  let extra = 0;
  if (imagePath && fs.existsSync(imagePath)) {
    setTimeout(() => {
      const id = sendPrivateImage(imagePath, '这张图里是什么');
      setTimeout(() => sendPrivateText('看看这个', id), 7000);
    }, 1200);
    extra = 15000;
  }
  if (autoGroup) {
    setTimeout(() => sendGroup(`<@${selfQQ}> 鲸鱼你在吗`, true), messages.length * 2000 + 1200 + extra);
  }
  if (args['friend-request']) {
    setTimeout(() => sendFriendRequest(Number(args['friend-qq'] ?? 10002)), 3000);
  }
  if (args.file) {
    const fp = path.resolve(String(args.file));
    setTimeout(() => sendPrivateFile(fp, args.cover ? '把这段翻唱一下' : '这个文件你看一下'), 5000);
  }
  if (args.sticker) {
    setTimeout(() => sendPrivateSticker(String(args.sticker)), 2000);
  }
  setTimeout(() => summarize(), messages.length * 2000 + 8000 + extra);
}

function sendPrivateSticker(text) {
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: ++msgId,
    self_id: selfQQ,
    user_id: userQQ,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userQQ, nickname: '测试用户', card: '' },
    message: [
      { type: 'mface', data: { text, summary: text, emoji_id: 'abc123' } },
      { type: 'face', data: { id: '14' } },
    ],
    raw_message: `[表情]${text}`,
  };
  messageStore.set(String(event.message_id), event);
  broadcast(event);
  log(`→ 私聊发送表情包：${text}`);
  return event.message_id;
}

function sendPrivateFile(file, text) {
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: ++msgId,
    self_id: selfQQ,
    user_id: userQQ,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userQQ, nickname: '测试用户', card: '' },
    message: [
      { type: 'file', data: { file: `file:///${file.replace(/\\/g, '/')}`, name: path.basename(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0 } },
      { type: 'text', data: { text } },
    ],
    raw_message: `[文件]${text}`,
  };
  messageStore.set(String(event.message_id), event);
  broadcast(event);
  log(`→ 私聊发送文件：${path.basename(file)} + ${text}`);
  return event.message_id;
}

function sendFriendRequest(fromQQ) {
  const event = {
    post_type: 'request',
    request_type: 'friend',
    time: Math.floor(Date.now() / 1000),
    self_id: selfQQ,
    user_id: fromQQ,
    comment: '你好，我是新朋友',
    flag: `flag-friend-${fromQQ}`,
  };
  broadcast(event);
  log(`→ 好友申请：来自 ${fromQQ}`);
}

function sendPrivate(text) {
  return sendPrivateText(text);
}

function sendPrivateText(text, quoteId) {
  const message = [];
  if (quoteId) message.push({ type: 'reply', data: { id: String(quoteId) } });
  message.push({ type: 'text', data: { text } });
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: ++msgId,
    self_id: selfQQ,
    user_id: userQQ,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userQQ, nickname: '测试用户', card: '' },
    message,
    raw_message: text,
  };
  messageStore.set(String(event.message_id), event);
  broadcast(event);
  log(`→ 私聊发送：${text}${quoteId ? `（引用 ${quoteId}）` : ''}`);
  return event.message_id;
}

function sendPrivateImage(file, text) {
  const event = {
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: ++msgId,
    self_id: selfQQ,
    user_id: userQQ,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userQQ, nickname: '测试用户', card: '' },
    message: [
      { type: 'image', data: { file: `file:///${file.replace(/\\/g, '/')}`, summary: '[图片]' } },
      { type: 'text', data: { text } },
    ],
    raw_message: `[图片]${text}`,
  };
  messageStore.set(String(event.message_id), event);
  broadcast(event);
  log(`→ 私聊发送图片：${path.basename(file)} + ${text}`);
  return event.message_id;
}

function sendGroup(text, at = false) {
  const message = [{ type: 'text', data: { text } }];
  if (at) message.unshift({ type: 'at', data: { qq: String(selfQQ) } });
  const event = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: ++msgId,
    self_id: selfQQ,
    group_id: groupId,
    user_id: userQQ,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userQQ, nickname: '测试用户', card: '测试用户' },
    message,
    raw_message: text,
  };
  messageStore.set(String(event.message_id), event);
  broadcast(event);
  log(`→ 群聊发送：${text}`);
}

function handleOutgoingFile(params) {
  const raw = String(params.file || '');
  const name = params.name || 'file.bin';
  if (!raw.startsWith('base64://')) {
    log(`← 机器人上传文件：${name}（非 base64）`);
    return;
  }
  const buf = Buffer.from(raw.slice('base64://'.length), 'base64');
  const target = path.join(receivedDir, `upload-${Date.now()}-${name.replace(/[\\/:*?"<>|]/g, '_')}`);
  fs.writeFileSync(target, buf);
  log(`← 机器人上传文件：${name}（${Math.round(buf.length / 1024)}KB）→ ${target}`);
}

function handleOutgoing(action, params) {
  const segments = Array.isArray(params.message) ? params.message : [{ type: 'text', data: { text: String(params.message) } }];
  const texts = [];
  let imageCount = 0;
  let voiceCount = 0;
  for (const s of segments) {
    if (s.type === 'text') texts.push(s.data?.text ?? '');
    else if (s.type === 'image') {
      imageCount++;
      saveImage(s.data?.file);
    } else if (s.type === 'record') {
      voiceCount++;
      saveVoice(s.data?.file);
    }
  }
  const line = texts.join('');
  sentTexts.push(line);
  log(
    `← 机器人回复（${action === 'send_group_msg' ? '群' : '私聊'}）：${line ? JSON.stringify(line) : '（无文字）'}` +
      `${voiceCount ? ` [+${voiceCount} 条语音]` : ''}${imageCount ? ` [+${imageCount} 张图]` : ''}`,
  );
}

function saveImage(file) {
  if (!file?.startsWith('base64://')) return;
  const buf = Buffer.from(file.slice('base64://'.length), 'base64');
  const name = path.join(receivedDir, `reply-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
  fs.writeFileSync(name, buf);
  log(`   图片已保存：${name}（${Math.round(buf.length / 1024)}KB）`);
}

function saveVoice(file) {
  if (!file?.startsWith('base64://')) return;
  const buf = Buffer.from(file.slice('base64://'.length), 'base64');
  const name = path.join(receivedDir, `voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  fs.writeFileSync(name, buf);
  log(`   语音已保存：${name}（${Math.round(buf.length / 1024)}KB）`);
}

function summarize() {
  log(`—— 自测结束，共收到 ${sentTexts.length} 条机器人消息 ——`);
  if (sentTexts.length) {
    log(`内容：${sentTexts.map((t) => JSON.stringify(t)).join(' | ')}`);
  } else {
    log('没有收到任何回复，检查配置或日志。');
  }
}

function log(msg) {
  console.log(`[mock ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

