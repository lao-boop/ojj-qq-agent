import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { isOwner } from './global.js';

const normalize = value => String(value || '').normalize('NFKC').trim().toLowerCase();

export class CoverDelivery {
  constructor({ cfg, onebot, logger, file = path.join(DATA_DIR, 'cover-deliveries.json') }) {
    Object.assign(this, { cfg, onebot, logger, file });
    try {
      this.records = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(this.records)) throw new Error('翻唱投递记录格式错误');
    } catch (error) { if (error.code !== 'ENOENT') throw error; this.records = []; }
    for (const record of this.records) if (record.status === 'sending') record.status = 'unknown';
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.records.slice(-500), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  resolve({ slots, instruction, actorId, chatKey, previous }) {
    if (slots.delivery !== 'other_chat') return { authorization: null };
    if (chatKey !== `private:${actorId}` || !isOwner(actorId, this.cfg)) return { reply: '请由主人在私聊中指定收歌人；当前不会向其他聊天发送音频。' };
    const query = normalize(slots.recipient);
    if (!query) return { reply: '要把翻唱发给谁？请提供已登记的收歌人昵称或 QQ 号。' };
    const matches = (this.cfg.voice?.recipients || []).filter(r => /^\d{5,12}$/.test(String(r.qq)) && (String(r.qq) === query || normalize(r.name) === query));
    if (matches.length !== 1) return { reply: matches.length ? '收歌人昵称重名，请使用具体 QQ 号。' : '没有找到已登记的收歌人。请先让对方加机器人好友，再由主人私聊发送 /收歌人 QQ号 昵称。' };
    const target = matches[0];
    const priorMatches = previous && previous.actorId === String(actorId) && previous.chatKey === chatKey && previous.qq === String(target.qq) && Date.now() - previous.at < 30 * 60 * 1000;
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const explicit = new RegExp(`(?:私发给?|发送给|转发给|发给|私聊(?:发|发送)?给?)\\s*(?:qq\\s*)?${literal}(?:吧|听听|听|一下)?(?:[，。！？、!?\\s]|$)`).test(normalize(instruction));
    const denied = /(不要|别|不用|不必|没让).{0,12}(发给|发送|私发|转发|私聊)/.test(instruction || '');
    if (denied || (!explicit && !priorMatches)) return { authorization: null, reply: '当前没有向对方发送。“唱给某人听”还不能确定要跨聊天发送；需要私发时，请明确说“翻唱后私发给某某”。' };
    return { authorization: priorMatches && !explicit ? previous : { id: randomUUID(), actorId: String(actorId), chatKey, qq: String(target.qq), name: String(target.name), at: Date.now() } };
  }
  assertAllowed(auth) {
    if (!auth || !isOwner(auth.actorId, this.cfg) || auth.chatKey !== `private:${auth.actorId}` || Date.now() - auth.at >= 30 * 60 * 1000 || !(this.cfg.voice?.recipients || []).some(r => String(r.qq) === auth.qq)) {
      throw new Error('收歌人授权已变更或过期，没有向对方发送音频');
    }
  }
  visible(chatKey) {
    const actorId = /^private:(\d+)$/.exec(chatKey || '')?.[1];
    if (!isOwner(actorId, this.cfg)) return [];
    return this.records.filter(r => r.sourceChat === chatKey).slice(-10).map(r => ({
      recipient: r.name, status: r.status, filename: r.filename, at: r.at, messageId: r.messageId || '',
    }));
  }
  async send({ authorization: auth, file, name, asVoice = true, seconds = 0 }) {
    this.assertAllowed(auth);
    if (this.records.some(r => r.id === auth.id)) throw new Error('此投递已有记录，不会重复发送；请先核对收歌情况');
    const buffer = fs.readFileSync(file);
    const record = { id: auth.id, requester: auth.actorId, sourceChat: auth.chatKey, qq: auth.qq, name: auth.name, file, filename: name, status: 'sending', at: Date.now() };
    this.records.push(record);
    this.save(); // A failed durable write must prevent the external send.
    let receipt;
    try {
      const payload = `base64://${buffer.toString('base64')}`;
      if (asVoice && seconds > 0 && seconds <= 55) receipt = await this.onebot.sendPrivate(Number(auth.qq), [{ type: 'record', data: { file: payload } }]);
      else receipt = await this.onebot.call('upload_private_file', { user_id: Number(auth.qq), file: payload, name }, 120000);
    } catch (error) {
      record.status = /retcode=|OneBot 未连接/.test(error.message) ? 'failed' : 'unknown';
      try { this.save(); } catch { this.logger?.warn?.('翻唱投递记录写入失败，禁止自动重发'); }
      throw new Error(record.status === 'unknown' ? `翻唱已生成，但给${auth.name}的发送结果未确认；不会自动重发，请先核对` : `翻唱已生成，但 QQ 未能发给${auth.name}，请检查好友关系或账号状态`);
    }
    record.status = 'sent';
    record.messageId = receipt?.message_id || '';
    try { this.save(); } catch { this.logger?.warn?.('QQ 已确认翻唱投递，但记录落盘失败；不要重复发送'); }
    return { ok: true, reply: `翻唱已发送给${auth.name}，QQ 接口已确认；这不代表对方已听取。` };
  }
}
