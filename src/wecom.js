import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AiBot, { generateReqId } from '@wecom/aibot-node-sdk';
import { DATA_DIR } from './config.js';
import { ffmpegBin } from './media.js';

const execFileAsync = promisify(execFile);

const MAX_REPLY_BYTES = 20000;

/** 去掉群消息里的 @机器人 前缀 */
function stripMention(text) {
  return String(text || '')
    .replace(/^\s*@[^\s@]+\s*/g, '')
    .replace(/\s*@[^\s@]+\s*$/g, '')
    .trim();
}

/**
 * 企业微信智能机器人（长连接）。
 * 只负责收发，不碰业务：消息交给 onMessage，返回要发送的文本。
 */
export class WeComBot {
  constructor({ botId, secret, logger, onMessage, onFile, onImage, fileReader, buildDocument }) {
    this.botId = String(botId || '').trim();
    this.secret = String(secret || '').trim();
    this.logger = logger;
    this.onMessage = onMessage;
    this.onFile = onFile || null;
    this.onImage = onImage || null;
    this.fileReader = fileReader || null;
    this.buildDocument = buildDocument || null;
    this.chatIds = new Map();
    this.client = null;
    this.seen = new Set();
    this.started = false;
  }

  get enabled() {
    return Boolean(this.botId && this.secret);
  }

  status() {
    return {
      enabled: this.enabled,
      started: this.started,
      connected: Boolean(this.client?.isConnected),
      botId: this.botId ? `${this.botId.slice(0, 8)}…` : '',
    };
  }

  start() {
    if (!this.enabled) {
      this.logger?.warn?.('企业微信未配置 WECOM_BOT_ID / WECOM_BOT_SECRET，跳过');
      return false;
    }
    if (this.started) return true;
    this.started = true;

    try {
      this.client = new AiBot.WSClient({ botId: this.botId, secret: this.secret });

      this.client.on('authenticated', () => this.logger?.info?.('企业微信长连接认证成功'));
      this.client.on('disconnected', (reason) => this.logger?.warn?.(`企业微信断开：${reason || ''}`));
      this.client.on('reconnecting', (n) => this.logger?.info?.(`企业微信重连中（第 ${n} 次）`));
      this.client.on('error', (err) => this.logger?.warn?.(`企业微信错误：${err?.message || err}`));

      this.client.on('message.text', (frame) => this.#handle(frame));
      this.client.on('message.mixed', (frame) => this.#handle(frame));
      this.client.on('message.voice', (frame) => this.#handle(frame));
      this.client.on('message.image', (frame) => this.#handle(frame));
      this.client.on('message.file', (frame) => this.#handle(frame));

      this.client.connect();
      this.logger?.info?.(`企业微信长连接已启动（bot ${this.botId.slice(0, 6)}…）`);
      return true;
    } catch (err) {
      this.started = false;
      this.logger?.warn?.(`企业微信启动失败：${err.message}`);
      return false;
    }
  }

  stop() {
    try {
      this.client?.disconnect();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.started = false;
  }

  async #handle(frame) {
    const body = frame?.body || {};
    const msgid = String(body.msgid || frame?.headers?.req_id || '');
    if (msgid) {
      if (this.seen.has(msgid)) return;
      this.seen.add(msgid);
      if (this.seen.size > 800) this.seen = new Set([...this.seen].slice(-400));
    }

    const chattype = body.chattype === 'group' ? 'group' : 'single';
    const chatid = String(body.chatid || '');
    const from = String(body.from?.userid || '');
    if (!from) return;
    if (chatid && chattype === 'single') this.chatIds.set(from, chatid);

    const chatKey = chattype === 'group' && chatid ? `wecom:group:${chatid}` : `wecom:user:${from}`;
    const title = chattype === 'group' ? `企微群 ${chatid.slice(-6)}` : `企微 ${from}`;

    // 取文本：text / mixed / voice / 引用
    let text = '';
    let skipBrain = false;
    const images = [];

    if (body.msgtype === 'text') {
      text = body.text?.content || '';
    } else if (body.msgtype === 'mixed') {
      for (const item of body.mixed?.msg_item || []) {
        if (item.msgtype === 'text') text += item.text?.content || '';
        if (item.msgtype === 'image' && item.image?.url) {
          const saved = await this.#download(item.image);
          if (saved) images.push({ file: saved });
        }
      }
    } else if (body.msgtype === 'voice') {
      text = body.voice?.content || '';
    } else if (body.msgtype === 'image' && body.image?.url) {
      const saved = await this.#download(body.image);
      if (saved) {
        images.push({ file: saved });
        text = '（对方发来一张图片）';
        if (this.onImage) {
          try {
            const note = await this.onImage({ from, chattype, chatid, file: saved });
            if (note) text += `\n${note}`;
          } catch (err) {
            this.logger?.warn?.(`企微图片转发失败：${err?.message || err}`);
          }
        }
      } else {
        text = '（对方发来一张图片，下载失败）';
        images.push({unavailable:true});
      }
    } else if (body.msgtype === 'file' && body.file?.url) {
      const saved = await this.#download(body.file);
      if (saved) {
        const name = path.basename(saved);
        // 文件先只落盘，不解析正文；等用户明确说“总结/看看/解析”时再读。
        // 这样“只转发文件”不会多出摘要，也不会白花解析成本。
        text = `（对方发来一个文件：${name}）`;
        if (this.onFile) {
          try {
            const note = await this.onFile({
              from,
              chattype,
              chatid,
              file: saved,
              name: body.file.filename || name,
            });
            if (note) text = note;
            skipBrain = true;
          } catch (err) {
            this.logger?.warn?.(`企微文件处理失败：${err.message}`);
            text += '\n（文件处理失败）';
          }
        }
      } else {
        text = '（对方发来一个文件，下载失败）';
      }
    }

    text = stripMention(text);
    if (!text && !images.length) return;
    if (skipBrain) {
      await this.#reply(frame, text);
      return;
    }

    this.logger?.info?.(`企微消息 ${chattype} ${from} chatid=${chatid || '-'}：${text.slice(0, 60)}`);

    try {
      const result = await this.onMessage({
        chatKey,
        title,
        text,
        images,
        chattype,
        from,
        chatid,
        frame,
      });
      const bubbles = Array.isArray(result) ? result : result?.bubbles || [];
      const reply = bubbles.join('\n\n');
      if (reply.trim()) await this.#reply(frame, reply);

      if (result && !Array.isArray(result)) {
        await this.#sendMedia(frame, result);

        // 文档任务：异步生成，完成后主动发到当前会话
        if (this.buildDocument && result.documents?.length) {
          const target = chattype === 'group' && chatid ? chatid : from;
          for (const job of result.documents) {
            this.#buildAndSend(job, target).catch((err) =>
              this.logger?.warn?.(`企微文档生成失败：${err.message}`),
            );
          }
        }
      }
    } catch (err) {
      this.logger?.warn?.(`企微处理失败：${err.message}`);
      await this.#reply(frame, '我这边刚出了点问题。').catch(() => {});
    }
  }

  async #download(media) {
    try {
      const { buffer, filename } = await this.client.downloadFile(media.url, media.aeskey);
      const dir = path.join(DATA_DIR, 'files');
      fs.mkdirSync(dir, { recursive: true });
      const suffix = (filename || 'media').replace(/[\\/:*?"<>|]/g, '_').slice(-40);
      // Do not overwrite an earlier upload with the same name in the same millisecond.
      for (let stamp = Date.now(); ; stamp++) {
        const file = path.join(dir, `${stamp}-wecom-${suffix}`);
        try {
          fs.writeFileSync(file, buffer, {flag:'wx'});
          return file;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
    } catch (err) {
      this.logger?.warn?.(`企微媒体下载失败：${err.message}`);
      return '';
    }
  }

  async sendImageTo(userid, file, name) {
    const raw = String(userid || '').trim();
    const target = this.chatIds.get(raw) || raw;
    if (!target) throw new Error('缺少接收人 userid');
    if (!fs.existsSync(file)) throw new Error('图片不存在');
    const size = fs.statSync(file).size;
    if (size > 10 * 1024 * 1024) throw new Error(`图片超过 10MB（${Math.round(size / 1024 / 1024)}MB）`);
    const fileName = name || path.basename(file);
    const up = await this.client.uploadMedia(fs.readFileSync(file), { type: 'image', filename: fileName });
    const mediaId = up?.media_id || up?.mediaId;
    if (!mediaId) throw new Error('上传没有返回 media_id');
    await this.client.sendMediaMessage(target, 'image', mediaId);
    this.logger?.info?.(`企微已转发图片给 ${target}`);
    return true;
  }

  async sendFileTo(userid, file, name) {
    const raw = String(userid || '').trim();
    const target = this.chatIds.get(raw) || raw;
    if (!target) throw new Error('缺少接收人 userid');
    if (!fs.existsSync(file)) throw new Error('文件不存在');
    const size = fs.statSync(file).size;
    if (size > 50 * 1024 * 1024) throw new Error(`文件超过 50MB（${Math.round(size / 1024 / 1024)}MB）`);
    const fileName = name || path.basename(file);
    const up = await this.client.uploadMedia(fs.readFileSync(file), { type: 'file', filename: fileName });
    const mediaId = up?.media_id || up?.mediaId;
    if (!mediaId) throw new Error('上传没有返回 media_id');
    const ack = await this.client.sendMediaMessage(target, 'file', mediaId);
    if (ack?.errcode !== 0) throw new Error(ack?.errmsg || '未收到文件发送成功回执');
    this.logger?.info?.(`企微已转发文件给 ${target}：${fileName}`);
    return true;
  }

  async sendTo(userid, text) {
    const raw = String(userid || '').trim();
    const target = this.chatIds.get(raw) || raw;
    if (!target) throw new Error('缺少接收人 userid');
    if (!this.client?.isConnected) throw new Error('企微长连接未连接');
    const content = String(text || '').slice(0, 2000);
    if (!content) throw new Error('内容为空');
    await this.client.sendMessage(target, { msgtype: 'markdown', markdown: { content } });
    this.logger?.info?.(`企微已发送文本给 ${target}`);
  }

  async #buildAndSend(job, target) {
    const built = await this.buildDocument(job);
    if (!built?.path || !fs.existsSync(built.path)) return;
    const name = built.name || path.basename(built.path);
    const up = await this.client.uploadMedia(fs.readFileSync(built.path), { type: 'file', filename: name });
    const mediaId = up?.media_id || up?.mediaId;
    if (!mediaId) throw new Error('上传没有返回 media_id');
    await this.client.sendMediaMessage(target, 'file', mediaId);
    this.logger?.info?.(`企微已发送文档：${name}`);
  }

  async #sendMedia(frame, result) {
    for (const img of (result.images || []).slice(0, 4)) {
      await this.#sendOne(frame, 'image', img.file, path.basename(img.file || 'image.jpg'));
    }
    for (const voice of result.voices || []) {
      await this.#sendVoice(frame, voice.file);
    }
    for (const f of result.files || []) {
      const file = f.path || f.file;
      await this.#sendOne(frame, 'file', file, f.name || path.basename(file || 'file'));
    }
    for (const v of result.videos || []) {
      await this.#sendOne(frame, 'video', v.file, v.name || path.basename(v.file || 'video.mp4'));
    }
  }

  async #sendVoice(frame, file) {
    if (!file) return;
    let amr = '';
    try {
      amr = await this.#toAmr(file);
    } catch (err) {
      this.logger?.warn?.(`企微语音转 AMR 失败：${err.message}`);
    }
    if (amr) {
      const size = fs.statSync(amr).size;
      if (size > 2 * 1024 * 1024) {
        // 企微语音上限约 2MB/60 秒，超了改发文件
        this.logger?.warn?.(`企微语音超过 2MB（${Math.round(size / 1024)}KB），改发文件`);
        await this.#sendOne(frame, 'file', amr, `${path.basename(file, path.extname(file))}.amr`);
        fs.unlink(amr, () => {});
        return;
      }
      await this.#sendOne(frame, 'voice', amr, path.basename(amr));
      fs.unlink(amr, () => {});
    } else {
      await this.#sendOne(frame, 'file', file, path.basename(file));
    }
  }

  async #sendOne(frame, type, file, name) {
    if (!file || !fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size > 50 * 1024 * 1024) {
      this.logger?.warn?.(`企微媒体超过 50MB，跳过：${name}`);
      return;
    }
    try {
      const up = await this.client.uploadMedia(fs.readFileSync(file), { type, filename: name });
      const mediaId = up?.media_id || up?.mediaId;
      if (!mediaId) throw new Error('上传没有返回 media_id');
      await this.client.replyMedia(frame, type, mediaId);
      this.logger?.info?.(`企微已发送 ${type}：${name}`);
    } catch (err) {
      this.logger?.warn?.(`企微发送 ${type} 失败：${err.message}`);
    }
  }

  async #toAmr(input) {
    const out = path.join(os.tmpdir(), `wecom-${Date.now()}.amr`);
    await execFileAsync(
      ffmpegBin(''),
      ['-y', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '8000', '-c:a', 'libopencore_amrnb', '-b:a', '12.2k', out],
      { timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!fs.existsSync(out) || fs.statSync(out).size < 200) throw new Error('没有产出 AMR');
    return out;
  }

  async #reply(frame, text) {
    let content = String(text);
    if (Buffer.byteLength(content, 'utf8') > MAX_REPLY_BYTES) {
      content = content.slice(0, 6000) + '\n\n（内容太长，先说到这）';
    }
    const streamId = generateReqId('stream');
    await this.client.replyStream(frame, streamId, content, true);
  }
}
