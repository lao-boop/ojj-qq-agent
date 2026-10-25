import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 简易日志：控制台 + data/logs/bot.log，并在内存里保留最近 500 行供控制台查看。 */
export class Logger {
  constructor({ level = 'info', file = true, name = 'bot', sink } = {}) {
    this.level = LEVELS[level] ?? 20;
    this.name = name;
    this.sink =
      sink ??
      {
        buffer: [],
        filePath: file ? path.join(DATA_DIR, 'logs', 'bot.log') : null,
      };
    if (!sink && this.sink.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.sink.filePath), { recursive: true });
        if (fs.existsSync(this.sink.filePath) && fs.statSync(this.sink.filePath).size > 8 * 1024 * 1024) {
          fs.renameSync(this.sink.filePath, `${this.sink.filePath}.1`);
        }
      } catch {
        this.sink.filePath = null;
      }
    }
  }

  child(name) {
    const sub = new Logger({ level: 'debug', name, sink: this.sink });
    sub.level = this.level;
    return sub;
  }

  setLevel(level) {
    if (LEVELS[level]) this.level = LEVELS[level];
  }

  log(level, msg, extra) {
    if ((LEVELS[level] ?? 20) < this.level) return;
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const suffix = extra === undefined ? '' : ' ' + safeJson(extra);
    const line = `[${time}] [${level.toUpperCase()}] [${this.name}] ${msg}${suffix}`;
    this.sink.buffer.push(line);
    if (this.sink.buffer.length > 500) this.sink.buffer.shift();
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (this.sink.filePath) {
      try {
        fs.appendFileSync(this.sink.filePath, line + '\n', 'utf8');
      } catch {
        /* 忽略写文件失败 */
      }
    }
  }

  debug(msg, extra) {
    this.log('debug', msg, extra);
  }
  info(msg, extra) {
    this.log('info', msg, extra);
  }
  warn(msg, extra) {
    this.log('warn', msg, extra);
  }
  error(msg, extra) {
    this.log('error', msg, extra);
  }
  tail(n = 200) {
    return this.sink.buffer.slice(-n);
  }
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}
