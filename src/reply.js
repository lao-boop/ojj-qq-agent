import fs from 'node:fs';
import path from 'node:path';
import { seg } from './onebot.js';
import { sleep } from './llm.js';

const rand = ([min, max]) => min + Math.random() * (max - min);

/** 把一条回复拆成“人味”：先等一下，再一条条发，中间有停顿。 */
export class ReplySender {
  constructor({ onebot, cfg, logger }) {
    this.onebot = onebot;
    this.cfg = cfg;
    this.logger = logger;
    this.chains = new Map();
  }

  updateConfig(cfg) {
    this.cfg = cfg;
  }

  send(chat, result, { quoteId } = {}) {
    const key = chat.key;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.#sendNow(chat, result, quoteId))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
    return next;
  }

  async #sendNow(chat, result, quoteId) {
    const { bubbles = [], images = [], voices = [] } = result;
    if (!bubbles.length && !images.length && !voices.length) return;

    await sleep(rand(this.cfg.firstDelayMs));

    for (let i = 0; i < bubbles.length; i++) {
      const text = bubbles[i];
      const segments = [];
      if (i === 0 && quoteId) segments.push(seg.reply(quoteId));
      segments.push(seg.text(text));
      await this.#call(chat, segments);
      if (i < bubbles.length - 1) {
        await sleep(rand(this.cfg.splitDelayMs) + Math.min(1200, text.length * 18));
      }
    }

    for (const voice of voices) {
      try {
        const buffer = fs.readFileSync(voice.file);
        await this.#call(chat, [{ type: 'record', data: { file: `base64://${buffer.toString('base64')}` } }]);
        await sleep(rand([400, 900]));
      } catch (err) {
        this.logger.warn(`发送语音失败：${err.message}`);
        throw err;
      }
    }

    for (const img of images) {
      try {
        const buffer = fs.readFileSync(img.file);
        const segments = [{ type: 'image', data: { file: `base64://${buffer.toString('base64')}` } }];
        await this.#call(chat, segments);
        await sleep(rand([300, 900]));
      } catch (err) {
        this.logger.warn(`发送图片失败：${err.message}`);
      }
    }
  }

  /**
   * 发音频：按配置决定用「语音条」还是「文件」。
   * mode: true 强制语音 / false 强制文件 / 'auto' 60 秒内走语音
   */
  async sendAudio(chat, filePath, name, text, mode = 'auto', duration = 0) {
    const seconds = duration || estimateDuration(filePath);
    const canVoice = seconds > 0 && seconds <= 55;
    const wantVoice = mode === true || (mode === 'auto' && canVoice);

    if (wantVoice && canVoice) {
      const buffer = fs.readFileSync(filePath);
      if (text) await this.#call(chat, [seg.text(text)]);
      await this.#call(chat, [{ type: 'record', data: { file: `base64://${buffer.toString('base64')}` } }]);
      this.logger.info(`已用语音条发送（约 ${Math.round(seconds)} 秒）`);
      return;
    }
    if (wantVoice && !canVoice) {
      this.logger.warn(`音频约 ${Math.round(seconds)} 秒，超过语音条上限，改发文件`);
    }
    return this.sendFile(chat, filePath, name, text);
  }

  /** 发文件（歌曲等大文件），QQ 里会显示成文件消息。 */
  async sendFile(chat, filePath, name, text) {
    const buffer = fs.readFileSync(filePath);
    const fileName = name || path.basename(filePath);
    const payload = { file: `base64://${buffer.toString('base64')}`, name: fileName };
    const action = chat.type === 'group' ? 'upload_group_file' : 'upload_private_file';
    const params = chat.type === 'group' ? { group_id: chat.groupId, ...payload } : { user_id: chat.userId, ...payload };

    // A timed-out upload may already have succeeded. Never retry it or reinterpret
    // a document as an audio recording. OneBot.call resolves only on API success.
    const receipt = await this.onebot.call(action, params, 120000);
    if (text) try { await this.#call(chat,[seg.text(text)]); } catch(err) { this.logger.warn(`文件已上传，文字通知失败：${err.message}`); }
    return { accepted:true, receipt:receipt || {}, transport:'file' };
  }

  #call(chat, segments) {
    if (chat.type === 'group') return this.onebot.sendGroup(chat.groupId, segments);
    return this.onebot.sendPrivate(chat.userId, segments);
  }
}

/** 没有 ffprobe，就按常见码率估算时长（够判断 60 秒上限）。 */
function estimateDuration(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp3') return (size * 8) / 128000; // 128kbps
    if (ext === '.wav') return size / (16000 * 2); // 16k 单声道 16bit
    if (ext === '.m4a' || ext === '.aac') return (size * 8) / 128000;
    return 0;
  } catch {
    return 0;
  }
}
