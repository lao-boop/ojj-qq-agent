import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WSClient } from '@wecom/aibot-node-sdk';
import * as proxyAgent from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

const HttpsProxyAgent = proxyAgent.HttpsProxyAgent ?? proxyAgent.default?.HttpsProxyAgent;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const STREAM_BYTES = 20480;
const MARKDOWN_BYTES = 4096;
const CONNECTION_KEYS = [
  'enabled', 'botId', 'secret', 'wsUrl', 'reconnectInterval', 'maxReconnectAttempts',
  'maxAuthFailureAttempts', 'heartbeatInterval', 'requestTimeout', 'maxReplyQueueSize',
];

function safeMessage(value, secret = '') {
  let text = value instanceof Error ? value.message : String(value ?? '');
  if (secret) text = text.split(secret).join('***');
  return text
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/((?:secret|aeskey|access_token|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1***')
    .slice(0, 1000);
}

function connectionKey(cfg) {
  return JSON.stringify(CONNECTION_KEYS.map((key) => cfg?.[key]));
}

function webSocketOptions(wsUrl = 'wss://openws.work.weixin.qq.com') {
  const target = new URL(wsUrl);
  if (!['ws:', 'wss:'].includes(target.protocol)) throw new Error('企业微信连接地址必须使用 ws 或 wss');
  // ws does not consume HTTP(S)_PROXY itself. Use the corresponding HTTP scheme
  // so inherited proxy settings (including lowercase variants and NO_PROXY) apply.
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  const proxy = getProxyForUrl(target);
  const options = { handshakeTimeout: 15000 };
  if (proxy) {
    let proxyUrl;
    try { proxyUrl = new URL(proxy); } catch { throw new Error('企业微信网络代理地址无效'); }
    if (!['http:', 'https:'].includes(proxyUrl.protocol)) throw new Error('企业微信网络代理仅支持 HTTP 或 HTTPS');
    options.agent = new HttpsProxyAgent(proxyUrl);
  }
  return options;
}

/** Official smart-bot WebSocket client; this is separate from QQ/OneBot. */
export class WeComTransport extends EventEmitter {
  constructor({ cfg = {}, logger, clientFactory = (options) => new WSClient(options) } = {}) {
    super();
    this.cfg = { ...cfg };
    this.logger = logger;
    this.clientFactory = clientFactory;
    this.client = null;
    this.proxyAgent = null;
    this.connected = false;
    this.socketConnected = false;
    this.stopped = true;
    this.state = 'stopped';
    this.lastError = '';
    this.reconnectAttempts = 0;
  }

  #log(level, message) {
    this.logger?.[level]?.(safeMessage(message, this.cfg.secret));
  }

  #status() {
    this.emit('status', this.status());
  }

  start() {
    if (!this.stopped && this.client) return false;
    if (this.client || this.proxyAgent) this.stop();
    if (this.cfg.enabled === false) {
      this.state = 'disabled';
      this.#status();
      return false;
    }
    if (!String(this.cfg.botId || '').trim() || !String(this.cfg.secret || '').trim()) {
      this.state = 'unconfigured';
      this.lastError = '企业微信智能机器人尚未配置 botId 和 secret';
      this.#status();
      return false;
    }

    this.stopped = false;
    this.connected = false;
    this.socketConnected = false;
    this.state = 'connecting';
    this.lastError = '';
    this.reconnectAttempts = 0;
    const secret = this.cfg.secret;
    // SDK debug logs contain whole callbacks, including private text and AES keys.
    const sdkLogger = { debug() {} };
    for (const level of ['info', 'warn', 'error']) {
      sdkLogger[level] = (message, ...args) => {
        const parts = [message, ...args].map((item) => {
          if (item && typeof item === 'object' && !(item instanceof Error)) return '[details omitted]';
          return safeMessage(item, secret);
        });
        this.logger?.[level]?.(parts.join(' '));
      };
    }

    try {
      const options = { botId: this.cfg.botId, secret, logger: sdkLogger };
      for (const key of CONNECTION_KEYS) {
        if (!['enabled', 'botId', 'secret'].includes(key) && this.cfg[key] !== undefined) options[key] = this.cfg[key];
      }
      options.wsOptions = webSocketOptions(this.cfg.wsUrl || undefined);
      this.proxyAgent = options.wsOptions.agent || null;
      const client = this.clientFactory(options);
      this.client = client;
      const active = () => !this.stopped && this.client === client;
      client.on('connected', () => {
        if (!active()) return;
        this.socketConnected = true;
        this.state = 'authenticating';
        this.#status();
      });
      client.on('authenticated', () => {
        if (!active()) return;
        this.connected = true;
        this.socketConnected = true;
        this.state = 'ready';
        this.lastError = '';
        this.reconnectAttempts = 0;
        this.emit('authenticated');
        this.emit('ready', { botId: this.cfg.botId });
        this.#status();
      });
      client.on('message', (frame) => {
        if (active() && this.connected) this.emit('message', frame);
      });
      client.on('event', (frame) => {
        if (!active()) return;
        if (frame?.body?.event?.eventtype === 'disconnected_event') {
          // The SDK stops reconnecting when another instance takes this bot over.
          this.stopped = true;
          this.connected = false;
          this.socketConnected = false;
          this.state = 'replaced';
          this.lastError = '同一机器人已在其他实例连接，当前连接停止自动重连';
          this.proxyAgent?.destroy();
          this.proxyAgent = null;
          this.#status();
        }
        this.emit('event', frame);
      });
      client.on('disconnected', (reason) => {
        if (!active()) return;
        this.connected = false;
        this.socketConnected = false;
        this.state = 'disconnected';
        this.lastError = safeMessage(reason, secret);
        this.#status();
      });
      client.on('reconnecting', (attempt) => {
        if (!active()) return;
        this.connected = false;
        this.socketConnected = false;
        this.state = 'reconnecting';
        this.reconnectAttempts = attempt;
        this.#status();
      });
      client.on('error', (err) => {
        if (!active()) return;
        this.lastError = safeMessage(err, secret);
        if (/EXHAUSTED/.test(err?.code || '')) this.state = 'failed';
        this.#log('warn', `企业微信连接错误：${this.lastError}`);
        if (this.listenerCount('error')) this.emit('error', new Error(this.lastError));
        this.#status();
      });
      this.#status();
      client.connect();
      return true;
    } catch (err) {
      this.stop();
      this.state = 'failed';
      this.lastError = safeMessage(err, secret);
      this.#log('warn', `企业微信连接失败：${this.lastError}`);
      this.#status();
      return false;
    }
  }

  stop() {
    const client = this.client;
    this.stopped = true;
    this.client = null;
    this.connected = false;
    this.socketConnected = false;
    this.state = this.cfg.enabled !== false ? 'stopped' : 'disabled';
    client?.removeAllListeners();
    try { client?.disconnect(); } catch (err) { this.#log('warn', err); }
    this.proxyAgent?.destroy();
    this.proxyAgent = null;
    this.#status();
  }

  updateConfig(cfg) {
    const changed = connectionKey(this.cfg) !== connectionKey(cfg);
    this.cfg = { ...cfg };
    if (changed) {
      this.stop();
      this.start();
    } else {
      this.#status();
    }
  }

  reconnect() {
    this.stop();
    return this.start();
  }

  status() {
    return {
      enabled: this.cfg.enabled !== false,
      configured: Boolean(this.cfg.botId && this.cfg.secret),
      connected: this.connected,
      authenticated: this.connected,
      socketConnected: this.socketConnected,
      botId: this.cfg.botId || '',
      state: this.state,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  requireClient() {
    if (this.stopped || !this.connected || !this.client) throw new Error('企业微信机器人未连接或尚未认证');
    return this.client;
  }
}

export { WeComTransport as WeCom };

/** Single chats use userid; group chats must never fall back to the sender. */
export function wecomChatId(frame) {
  const body = frame?.body || {};
  const value = body.chattype === 'group' ? body.chatid : body.from?.userid;
  if (typeof value !== 'string' || !value.trim()) throw new Error('企业微信消息缺少会话 ID');
  return value;
}

function splitUtf8(text, limit) {
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const char of String(text ?? '')) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > limit && current) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current) parts.push(current);
  return parts;
}

/** Delivers only when explicitly called by the runtime handling a user's request. */
export class WeComSender {
  constructor({ transport, logger } = {}) {
    this.transport = transport;
    this.logger = logger;
    this.chains = new Map();
  }

  #queue(frame, operation) {
    const client = this.transport.requireClient();
    const chatId = wecomChatId(frame);
    const previous = this.chains.get(chatId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.transport.requireClient() !== client) throw new Error('企业微信连接已更换，取消旧连接上的发送');
      return operation(client, chatId);
    }).finally(() => {
      if (this.chains.get(chatId) === next) this.chains.delete(chatId);
    });
    this.chains.set(chatId, next);
    return next;
  }

  #checkClient(client) {
    if (this.transport.requireClient() !== client) throw new Error('企业微信连接已更换，取消旧连接上的发送');
  }

  async replyText(frame, text, { finish = true, streamId = randomUUID() } = {}) {
    if (!frame?.headers?.req_id) throw new Error('企业微信回复缺少 req_id');
    if (Buffer.byteLength(String(text ?? ''), 'utf8') > STREAM_BYTES) throw new Error('企业微信流式回复超过 20480 字节');
    await this.#queue(frame, (client) => client.replyStream(frame, streamId, String(text ?? ''), finish));
    return streamId;
  }

  async sendText(frame, text) {
    return this.#queue(frame, async (client, chatId) => {
      for (const content of splitUtf8(text, MARKDOWN_BYTES)) {
        this.#checkClient(client);
        await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
      }
    });
  }

  async #uploadAndSend(client, chatId, filePath, name, type, validate = () => true) {
    if (!validate()) throw new Error('附件发送权限或任务状态已变化');
    this.#checkClient(client);
    const info = await fs.stat(filePath);
    if (!info.isFile() || info.size === 0) throw new Error('企业微信附件为空或不是文件');
    if (info.size > MAX_UPLOAD_BYTES) throw new Error('企业微信附件不能超过 50 MB');
    const buffer = await fs.readFile(filePath);
    const filename = path.basename(String(name || filePath)).replace(/[\\/:*?"<>|\r\n]/g, '_');
    this.#checkClient(client);
    const media = await client.uploadMedia(buffer, { type, filename });
    if (!media?.media_id) throw new Error('企业微信上传未返回 media_id');
    this.#checkClient(client);
    if (!validate()) throw new Error('附件发送权限或任务状态已变化');
    await client.sendMediaMessage(chatId, type, media.media_id, type === 'video' ? { title: filename } : undefined);
    return media;
  }

  async sendFile(frame, filePath, name, {validate} = {}) {
    return this.#queue(frame, (client, chatId) => this.#uploadAndSend(client, chatId, filePath, name, 'file', validate));
  }

  async sendResult(frame, result = {}, { streamId, proactive = false, deadlineAt, validate = () => true } = {}) {
    return this.#queue(frame, async (client, chatId) => {
      if (!validate()) throw new Error('回复权限已变化');
      // A preceding upload may have consumed the callback's remaining lifetime.
      const activeDelivery = proactive || (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt);
      const text = (result.bubbles || []).filter(Boolean).join('\n\n');
      const chunks = splitUtf8(text, STREAM_BYTES);
      if (activeDelivery) {
        for (const content of splitUtf8(text, MARKDOWN_BYTES)) {
          this.#checkClient(client);
          await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
        }
      } else if (chunks.length || streamId) {
        if (!frame?.headers?.req_id) throw new Error('企业微信回复缺少 req_id');
        await client.replyStream(frame, streamId || randomUUID(), chunks.shift() || '', true);
        for (const chunk of chunks) {
          for (const content of splitUtf8(chunk, MARKDOWN_BYTES)) {
            this.#checkClient(client);
            await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } });
          }
        }
      }
      for (const item of result.images || []) {
        const ext = path.extname(item.file || '').toLowerCase();
        const type = ['.jpg', '.jpeg', '.png'].includes(ext) ? 'image' : 'file';
        await this.#uploadAndSend(client, chatId, item.file, item.name, type);
      }
      // Existing Edge TTS/humming output is MP3/WAV, not the platform's AMR voice format.
      for (const item of result.voices || []) {
        const type = path.extname(item.file || '').toLowerCase() === '.amr' ? 'voice' : 'file';
        await this.#uploadAndSend(client, chatId, item.file, item.name, type);
      }
      for (const item of result.videos || []) {
        const type = path.extname(item.file || '').toLowerCase() === '.mp4' ? 'video' : 'file';
        await this.#uploadAndSend(client, chatId, item.file, item.name, type);
      }
      for (const item of result.files || []) {
        await this.#uploadAndSend(client, chatId, item.path, item.name, 'file', validate);
      }
    });
  }
}
