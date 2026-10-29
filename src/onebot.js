import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const API_TIMEOUT = 20000;

/** OneBot v11 正向 WebSocket 客户端（NapCat / SnowLuma 都支持）。 */
export class OneBot extends EventEmitter {
  constructor({ wsUrl, accessToken = '', logger }) {
    super();
    this.wsUrl = wsUrl;
    this.accessToken = accessToken;
    this.logger = logger;
    this.ws = null;
    this.connected = false;
    this.selfId = 0;
    this.nickname = '';
    this.pending = new Map();
    this.echoSeq = 0;
    this.attempt = 0;
    this.stopped = false;
    this.timer = null;
    this.lastError = '';
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.connected = false;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('连接已关闭，发送结果未确认'),{deliveryState:'unknown'})); }
    this.pending.clear();
  }

  #url() {
    if (!this.accessToken) return this.wsUrl;
    const u = new URL(this.wsUrl);
    u.searchParams.set('access_token', this.accessToken);
    return u.toString();
  }

  #connect() {
    if (this.stopped) return;
    const url = this.#url();
    this.logger.info(`正在连接 OneBot：${url.replace(/access_token=[^&]+/, 'access_token=***')}`);
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
        handshakeTimeout: 10000,
      });
    } catch (err) {
      this.logger.error(`创建 WebSocket 失败：${err.message}`);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', async () => {
      this.connected = true;
      this.attempt = 0;
      this.logger.info('OneBot 已连接');
      this.emit('status', this.status());
      try {
        const info = await this.call('get_login_info');
        this.selfId = Number(info?.user_id ?? 0);
        this.nickname = String(info?.nickname ?? '');
        this.logger.info(`登录账号：${this.nickname}（${this.selfId}）`);
        this.emit('ready', { selfId: this.selfId, nickname: this.nickname });
        this.emit('status', this.status());
      } catch (err) {
        this.logger.warn(`get_login_info 失败：${err.message}`);
      }
    });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (data.echo && this.pending.has(String(data.echo))) {
        const p = this.pending.get(String(data.echo));
        this.pending.delete(String(data.echo));
        clearTimeout(p.timer);
        if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data ?? {});
        else p.reject(Object.assign(new Error(`${data.wording || data.message || 'OneBot 调用失败'}（retcode=${data.retcode}）`),{deliveryState:'rejected',retcode:data.retcode}));
        return;
      }
      this.#onEvent(data);
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('OneBot 连接断开，调用结果未确认'),{deliveryState:'unknown'})); }
      this.pending.clear();
      const wasConnected = this.connected;
      this.connected = false;
      this.logger.warn(`OneBot 断开（code=${code}${reason ? `，${reason}` : ''}）${wasConnected ? '' : '，连接未建立'}`);
      this.emit('status', this.status());
      this.#scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.lastError = err.message;
      this.logger.warn(`OneBot 连接错误：${err.message}`);
    });
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.attempt = Math.min(this.attempt + 1, 10);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5)) + Math.floor(Math.random() * 500);
    this.logger.info(`${Math.round(delay / 1000)} 秒后重连（第 ${this.attempt} 次）`);
    this.timer = setTimeout(() => this.#connect(), delay);
  }

  #onEvent(data) {
    this.logger.debug(`事件：${data.post_type}${data.request_type ? `/${data.request_type}` : ''}${data.notice_type ? `/${data.notice_type}` : ''}`);
    if (data.post_type === 'message') {
      this.emit('message', data);
    } else if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'lifecycle') {
        this.logger.info(`生命周期事件：${data.sub_type}`);
        if (data.sub_type === 'connect' && data.self_id) {
          this.selfId = Number(data.self_id);
          this.emit('status', this.status());
        }
      }
    } else if (data.post_type === 'notice') {
      this.emit('notice', data);
    } else if (data.post_type === 'request') {
      this.emit('request', data);
    }
  }

  call(action, params = {}, timeout = API_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(Object.assign(new Error('OneBot 未连接'),{deliveryState:'not_sent'}));
        return;
      }
      const echo = `c${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(Object.assign(new Error(`OneBot 调用超时：${action}`),{deliveryState:'unknown'}));
      }, timeout);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err);
      }
    });
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message }, Array.isArray(message) && message.some(s => s.type === 'record') ? 120000 : API_TIMEOUT);
  }

  sendGroup(groupId, message) {
    return this.call('send_group_msg', { group_id: Number(groupId), message }, Array.isArray(message) && message.some(s => s.type === 'record') ? 120000 : API_TIMEOUT);
  }

  getLoginInfo() {
    return this.call('get_login_info');
  }

  status() {
    return {
      connected: this.connected,
      selfId: this.selfId,
      nickname: this.nickname,
      wsUrl: this.wsUrl,
      lastError: this.lastError,
    };
  }
}

export const seg = {
  text: (text) => ({ type: 'text', data: { text } }),
  image: (file) => ({ type: 'image', data: { file } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
  reply: (id) => ({ type: 'reply', data: { id: String(id) } }),
};

export function imageSegFromFile(absPath, buffer) {
  return { type: 'image', data: { file: `base64://${buffer.toString('base64')}`, name: absPath } };
}
