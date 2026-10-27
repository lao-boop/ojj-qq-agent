import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const PUBLIC_DIR = path.join(ROOT, 'public');

const MASK = '••••';

export function maskSecret(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 8) return MASK;
  return `${s.slice(0, 3)}${MASK}${s.slice(-4)}`;
}

export function isMasked(v) {
  return typeof v === 'string' && v.includes(MASK);
}

export class ConsoleServer {
  constructor({ cfg, logger, hooks }) {
    this.cfg = cfg;
    this.logger = logger.child('console');
    this.hooks = hooks;
    this.server = null;
  }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  start() {
    if (!this.cfg.console.enabled) return;
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        this.logger.error(`控制台请求失败：${err.stack || err.message}`);
        sendJson(res, 500, { ok: false, error: err.message });
      });
    });
    this.server.listen(this.cfg.console.port, this.cfg.console.host, () => {
      this.logger.info(`控制台已启动：http://${this.cfg.console.host}:${this.cfg.console.port}`);
    });
    this.server.on('error', (err) => {
      this.logger.error(`控制台启动失败：${err.message}（端口 ${this.cfg.console.port} 可能被占用）`);
    });
  }

  stop() {
    this.server?.close();
  }

  #authorized(req, url) {
    const token = this.cfg.console.token;
    if (!token) return true;
    const header = req.headers['x-console-token'];
    const query = url.searchParams.get('token');
    return header === token || query === token;
  }

  async #handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return this.#static(res, 'index.html');
    }
    if (!url.pathname.startsWith('/api/')) {
      return this.#static(res, url.pathname.replace(/^\/+/, ''));
    }
    if (!this.#authorized(req, url)) {
      return sendJson(res, 401, { ok: false, error: '控制台令牌不正确' });
    }

    try {
      switch (`${method} ${url.pathname}`) {
        case 'GET /api/status':
          return sendJson(res, 200, { ok: true, ...this.hooks.status() });
        case 'GET /api/config':
          return sendJson(res, 200, { ok: true, config: this.#publicConfig() });
        case 'POST /api/config': {
          const body = await readJson(req);
          const result = await this.hooks.applyConfig(body.patch ?? body);
          return sendJson(res, 200, { ok: true, config: this.#publicConfig(), result });
        }
        case 'GET /api/persona':
          return sendJson(res, 200, { ok: true, text: this.hooks.getPersona() });
        case 'POST /api/persona': {
          const body = await readJson(req);
          this.hooks.setPersona(String(body.text ?? ''));
          return sendJson(res, 200, { ok: true });
        }
        case 'GET /api/sessions':
          return sendJson(res, 200, { ok: true, sessions: this.hooks.listSessions() });
        case 'GET /api/session': {
          const key = url.searchParams.get('key') || '';
          return sendJson(res, 200, { ok: true, session: this.hooks.getSession(key) });
        }
        case 'DELETE /api/session': {
          const key = url.searchParams.get('key') || '';
          this.hooks.deleteSession(key);
          return sendJson(res, 200, { ok: true });
        }
        case 'POST /api/test': {
          const body = await readJson(req);
          const text = String(body.text ?? '').trim();
          if (!text) return sendJson(res, 400, { ok: false, error: '内容为空' });
          const result = await this.hooks.testChat(text);
          return sendJson(res, 200, { ok: true, ...result });
        }
        case 'GET /api/logs':
          return sendJson(res, 200, { ok: true, lines: this.hooks.logs(Number(url.searchParams.get('limit') ?? 200)) });
        case 'POST /api/reconnect':
          this.hooks.reconnect();
          return sendJson(res, 200, { ok: true });
        case 'POST /api/restart':
          return sendJson(res, 200, { ok: true });
        default:
          return sendJson(res, 404, { ok: false, error: '接口不存在' });
      }
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  #publicConfig() {
    const c = structuredClone(this.cfg);
    if (c.llm?.apiKey) c.llm.apiKey = maskSecret(c.llm.apiKey);
    if (c.onebot?.accessToken) c.onebot.accessToken = maskSecret(c.onebot.accessToken);
    if (c.console?.token) c.console.token = maskSecret(c.console.token);
    if (c.image?.apiKey) c.image.apiKey = maskSecret(c.image.apiKey);
    if (c.song?.token) c.song.token = maskSecret(c.song.token);
    return c;
  }

  #static(res, name) {
    const file = path.join(PUBLIC_DIR, name);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return sendJson(res, 404, { ok: false, error: '文件不存在' });
    }
    const ext = path.extname(file).toLowerCase();
    const type =
      { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[
        ext
      ] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}
