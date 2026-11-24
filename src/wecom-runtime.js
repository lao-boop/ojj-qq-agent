import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { messageTimes, beijingTime } from './wecom-directory.js';

const encode = (value) => encodeURIComponent(String(value));
export const wecomScope = (botId) => `wecom:${encode(botId || 'unconfigured')}:`;

export function wecomConversation(frame, botId) {
  const body = frame?.body;
  if (!body || !frame.headers?.req_id || !body.msgid || !body.from?.userid) return null;
  if (body.aibotid !== botId || !['single', 'group'].includes(body.chattype)) return null;
  const userId = String(body.from.userid);
  const group = body.chattype === 'group';
  if (group && !body.chatid) return null;
  const id = group ? String(body.chatid) : userId;
  return {
    key: `${wecomScope(botId)}${group ? 'group' : 'private'}:${encode(id)}`,
    userId, group, id,
    title: `企业微信${group ? '群聊' : '私聊'} ${id}`,
    meta: { scene: group ? '企业微信群聊' : '企业微信私聊', peerName: userId, groupName: group ? id : '' },
  };
}

export function allowedWecom(chat, cfg) {
  if (cfg.mode === 'open') return true;
  if (cfg.mode !== 'whitelist') return false;
  const list = chat.group ? cfg.groupAllow : cfg.userAllow;
  return Array.isArray(list) && list.map(String).includes(chat.id);
}

const safeFilename = (name) => path.basename(String(name || 'attachment').replace(/\\/g, '/'))
  .replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(-100) || 'attachment';

/** Orchestration only: no QQ connection, numeric IDs, or global QQ memories. */
export class WeComRuntime {
  constructor({ cfg, transport, sender, brain, memory, fileReader, officeFactory, songGen, dataDir, logger, secretary, contacts, documents }) {
    Object.assign(this, { cfg, transport, sender, brain, memory, fileReader, officeFactory, songGen, dataDir, logger, secretary, contacts, documents });
    this.chains = new Map();
    this.seen = new Map();
    this.buckets = new Map();
    this.jobs = new Map();
    this.jobQueue = [];
    this.runningJobs = 0;
    this.pendingMessages = 0;
    this.songUsage = new Map();
    this.generation = 0;
    this.identity = `${cfg.wecom.botId}\0${cfg.wecom.secret}`;
    this.stopped = false;
    this.stats = { received: 0, replied: 0, ignored: 0, errors: 0, startedAt: Date.now() };
    this.listener = (frame) => { this.handle(frame).catch(() => this.logger.warn('企业微信消息处理失败')); };
  }

  start() {
    this.stopped = false;
    this.transport.on('message', this.listener);
    this.transport.start();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.transport.off('message', this.listener);
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobQueue = [];
    this.transport.stop();
  }

  updateConfig(cfg) {
    const identity = `${cfg.wecom.botId}\0${cfg.wecom.secret}`;
    if (identity !== this.identity) {
      this.generation++;
      for (const job of this.jobs.values()) job.controller.abort();
      this.seen.clear();
    }
    this.identity = identity;
    this.cfg = cfg;
    this.transport.updateConfig(cfg.wecom);
  }

  #current(generation) { return !this.stopped && generation === this.generation; }

  #limited(key) {
    const limit = this.cfg.chat.rateLimit?.perChatPerMinute ?? 12;
    if (limit <= 0) return false;
    const now = Date.now();
    const bucket = (this.buckets.get(key) || []).filter((time) => now - time < 60000);
    if (bucket.length >= limit) return true;
    bucket.push(now);
    this.buckets.set(key, bucket);
    if (this.buckets.size > 5000) this.buckets.delete(this.buckets.keys().next().value);
    return false;
  }

  async handle(frame) {
    this.stats.received++;
    const chat = wecomConversation(frame, this.cfg.wecom.botId);
    if (this.stopped || !chat || !allowedWecom(chat, this.cfg.wecom)) {
      this.stats.ignored++;
      return;
    }
    const now = Date.now();
    for (const [key, time] of this.seen) if (now - time > 10 * 60000) this.seen.delete(key);
    const dedup = `${wecomScope(this.cfg.wecom.botId)}${frame.body.msgid}`;
    if (this.seen.has(dedup)) { this.stats.ignored++; return; }
    this.seen.set(dedup, now);
    chat.receivedAt = now;
    chat.identity = this.contacts?.peek(chat.userId);
    const archiveId = this.secretary?.capture(frame, chat);
    if (this.secretary?.enabled() && !archiveId) { this.stats.ignored++; return; }
    if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
    if (this.#limited(chat.key) || this.pendingMessages >= 50) {
      this.stats.ignored++;
      await this.sender.replyText(frame, '消息有点多，请稍后再试。');
      return;
    }
    const generation = this.generation;
    const streamId = randomUUID();
    this.pendingMessages++;
    // Download short-lived media immediately, even while another turn is running.
    // Attach rejection handling immediately as this promise may wait in a queue.
    const identified = (async () => {
      const identity = this.contacts ? await this.contacts.resolve(chat.userId) : { userId: chat.userId, name: '', source: '仅平台UserID' };
      if (!this.#current(generation)) return;
      chat.identity = identity;
      const times = messageTimes(frame.body, now);
      chat.meta.peerName = identity.name || chat.userId;
      chat.meta.message = { userId: chat.userId, name: identity.name || '', department: identity.department || '',
        position: identity.position || '', identitySource: identity.source, identityStale: !!identity.stale,
        platformTime: times.platformAt ? beijingTime(times.platformAt) : null, receivedTime: beijingTime(now) };
      if (!chat.group && identity.name) chat.title = `企业微信私聊 ${identity.name}（${chat.userId}）`;
      this.secretary?.attachIdentity?.(archiveId, identity);
    })();
    const prepared = Promise.all([this.#prepare(frame.body), identified]).then(([value]) => {
      if (!this.#current(generation) || !allowedWecom(chat, this.cfg.wecom)) return {value};
      this.secretary?.attachExtraction(archiveId, value);
      this.documents?.capture(chat, value.files, frame.body.msgid);
      return { value };
    }).catch(error => ({ error }));
    const acknowledged = this.sender.replyText(frame, this.chains.has(chat.key) ? '收到，正在按顺序处理。' : '收到，让我看看。', { streamId, finish: false })
      .then(() => true, () => false);
    const previous = this.chains.get(chat.key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!this.#current(generation) || !allowedWecom(chat, this.cfg.wecom)) return;
      const ack = await acknowledged;
      const input = await prepared;
      const proactive = !ack || Date.now() - now >= (this.cfg.wecom.requestTimeoutMs || 240000);
      if (ack && proactive && this.#current(generation)) {
        await this.sender.replyText(frame, '等待较久，处理完成后会另发结果。', { streamId, finish: true }).catch(() => {});
      }
      await this.#respond({ frame, chat, input, streamId, generation, proactive, archiveId, receivedAt: now });
    }).finally(() => {
      this.pendingMessages--;
      if (this.chains.get(chat.key) === next) this.chains.delete(chat.key);
    });
    this.chains.set(chat.key, next);
    return next;
  }

  async #prepare(body) {
    const texts = [];
    const images = [];
    const files = [];
    let count = 0;
    const visit = async (item, quoted = false) => {
      if (!item) return;
      if (item.msgtype === 'text') texts.push(`${quoted ? '[引用内容] ' : ''}${String(item.text?.content || '').slice(0, 30000)}`);
      else if (item.msgtype === 'voice') texts.push(`[语音转写] ${String(item.voice?.content || '').slice(0, 30000)}`);
      else if (item.msgtype === 'mixed') {
        for (const part of (item.mixed?.msg_item || []).slice(0, 10)) await visit(part, quoted);
      } else if (['image', 'file'].includes(item.msgtype)) {
        if (++count > 4 || (item.msgtype === 'image' && images.length >= 3)) return;
        const media = item[item.msgtype];
        if (!media?.url || !media.aeskey || !/^https:\/\//i.test(media.url)) {
          texts.push('[附件无法读取：缺少有效下载地址或解密信息]');
          return;
        }
        try {
          const { buffer, filename } = await this.transport.client.downloadFile(media.url, media.aeskey);
          if (!Buffer.isBuffer(buffer) || buffer.length > 100 * 1024 * 1024) throw new Error('attachment too large');
          if (item.msgtype === 'image') {
            if (buffer.length > 8 * 1024 * 1024) throw new Error('image too large');
            images.push({ partsSource:!quoted, base64: `base64://${buffer.toString('base64')}` });
          } else {
            const name = safeFilename(filename || media.filename || 'attachment');
            const dir = path.join(this.dataDir, 'wecom-files');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `${randomUUID()}-${name}`);
            fs.writeFileSync(file, buffer, { mode: 0o600 });
            const extracted = await this.fileReader.extractText({ path: file, name, size: buffer.length });
            if (!quoted) files.push({path:file,name,text:extracted.ok ? extracted.text || '' : '',chars:extracted.chars || 0});
            texts.push(`【${quoted ? '引用' : '收到'}文件：${name}】\n${extracted.ok ? String(extracted.text || '').slice(0, 6000) : '未能提取正文，请发送可读的文档或文字。'}`);
            const pics = await this.fileReader.extractImages({ path: file, name });
            images.push(...pics.slice(0, Math.max(0, 3 - images.length)).map(file => ({ file })));
          }
        } catch {
          texts.push('[附件读取失败，可能已过期、过大或解密失败，请重新发送]');
        }
      } else if (item.msgtype === 'video') {
        texts.push('[收到视频：当前企业微信入口暂不解析视频，请发送截图或文字说明]');
      } else {
        texts.push('[收到暂不支持的消息类型，请发送文字、图片、语音或文件]');
      }
    };
    await visit(body);
    if (body.quote) await visit(body.quote, true);
    return { text: texts.filter(Boolean).join('\n').slice(0, 40000), images, files };
  }

  async #respond({ frame, chat, input, streamId, generation, proactive, archiveId, receivedAt }) {
    let streamClosed = proactive;
    let finalAttempted = false;
    let timer;
    const valid = () => this.#current(generation) && allowedWecom(chat, this.cfg.wecom);
    const deliver = async (result) => {
      if (!valid()) return false;
      finalAttempted = true;
      await this.sender.sendResult(frame, result, { streamId, proactive: streamClosed,
        validate: () => valid() && (result.files || []).every(f => f.documentAccessGeneration === undefined
          || (this.documents?.isOwner(chat.key) && f.documentAccessGeneration === this.documents.generation)),
        deadlineAt: receivedAt + (this.cfg.wecom.requestTimeoutMs || 240000) });
      streamClosed = true;
      return true;
    };
    try {
      if (input.error) throw input.error;
      if (!valid()) return;
      const command = frame.body.msgtype === 'text' ? String(frame.body.text?.content || '').trim() : '';
      const secretaryReply = await this.secretary?.command(command, chat.key);
      if (secretaryReply != null) {
        if (await deliver({ bubbles: [secretaryReply] }) && valid() && !command.startsWith('/') && this.secretary.isOwner(chat.key)) {
          this.memory.append(chat.key,'user',command,chat.title);
          this.memory.append(chat.key,'assistant',secretaryReply,chat.title);
        }
        return;
      }
      if (command === '/我是谁') {
        const m = chat.meta.message;
        await deliver({ bubbles: [`员工：${m?.name || '姓名尚未匹配'}（UserID：${chat.userId}）\n部门：${m?.department || '未知'}\n身份来源：${m?.identitySource || '仅平台UserID'}${m?.identityStale ? '（缓存已过期，尚未重新核验）' : ''}\n平台消息时间：${m?.platformTime || '平台未提供'}\n接收时间：${m?.receivedTime || beijingTime(receivedAt)}`] });
        return;
      }
      if (command === '/help') {
        await deliver({ bubbles: ['我是小鲸鱼。可以聊天、记事、读图片和文件、生成文档。/reset 清空当前会话，/cancel 取消当前会话的后台任务。'] });
        return;
      }
      if (command === '/reset') {
        if (chat.group) await deliver({ bubbles: ['群聊记忆由管理员在本地控制台管理。私聊可使用 /reset 清空自己的会话。'] });
        else { this.memory.clear(chat.key); await deliver({ bubbles: ['这个私聊的记忆已清空。'] }); }
        return;
      }
      if (command === '/cancel') {
        let count = 0;
        for (const job of this.jobs.values()) {
          if (job.chatKey === chat.key && job.userId === chat.userId && !job.controller.signal.aborted) {
            job.controller.abort(); count++;
          }
        }
        await deliver({ bubbles: [count ? `已取消 ${count} 个任务的后续处理。已提交云端的生成可能仍会计费。` : '当前没有你发起的后台任务。'] });
        return;
      }
      const remaining = Math.max(1, (this.cfg.wecom.requestTimeoutMs || 240000) - (Date.now() - receivedAt));
      if (!streamClosed) {
        timer = setTimeout(() => {
          if (!valid() || streamClosed) return;
          streamClosed = true;
          this.sender.replyText(frame, '这次处理时间较长，完成后会补发结果。', { streamId, finish: true }).catch(() => {});
        }, remaining);
        timer.unref?.();
      }
      const result = await this.brain.respond({
        chatKey: chat.key, title: chat.title,
        userText: chat.group ? `[发言者：${chat.userId}]\n${input.value.text}` : input.value.text,
        onPartsImages:archiveId && this.secretary?.attachImageReading && chat.userId!==this.cfg.wecom.secretary?.ownerUserId ? text=>{
          if(valid())this.secretary.attachImageReading(archiveId,text);
        }:undefined,
        images: input.value.images, meta: chat.meta, persistAssistant: false,
        onProgress: async () => {
          if (valid() && !streamClosed) await this.sender.replyText(frame, '正在生成图片，请稍等。', { streamId, finish: false });
        },
      });
      clearTimeout(timer);
      if (!await deliver(result)) return;
      if (valid() && this.secretary?.isOwner(chat.key) && (result.evidence?.length || result.rollupEvidence)) {
        const ids=(result.evidence||[]).map(e=>e.id);
        const delivered = result.reportSources ?? [...ids,...(result.rollupEvidence?.sources||[])];
        this.secretary.rememberSources(delivered,result.rollupEvidence?.focus);
      }
      const sentText = (result.bubbles || []).join('\n');
      if (sentText) this.memory.append(chat.key, 'assistant', sentText, chat.title,
        {reportEvidence:!!(result.evidence?.length || result.rollupEvidence?.sources?.length),reportSources:result.reportSources,reportMatter:result.reportMatter});
      this.stats.replied++;
      for (const job of result.documents || []) this.#scheduleJob('document', job, frame, chat, generation);
      for (const job of result.songs || []) this.#scheduleJob('song', job, frame, chat, generation);
    } catch {
      this.stats.errors++;
      this.logger.warn('企业微信处理或交付失败');
      if (valid()) {
        const text = '这次处理或发送失败了，结果还没有完整送达，请稍后再试。';
        try {
          // A final stream may already have succeeded before a media upload failed.
          if (!streamClosed && !finalAttempted) await this.sender.replyText(frame, text, { streamId, finish: true });
          else await this.sender.sendText(frame, text);
          this.memory.append(chat.key, 'assistant', '[本次处理或交付失败，未确认完整送达]', chat.title);
        } catch { /* Connection errors are reported by transport; never claim delivery. */ }
      }
    } finally { clearTimeout(timer); }
  }

  #scheduleJob(kind, spec, frame, chat, generation) {
    const decline = (text) => this.sender.sendText(frame, text).catch(() => {});
    if (this.jobs.size >= 20) { decline('后台任务已满，这次任务未启动，请稍后再试。'); return; }
    if (kind === 'song') {
      const day = new Date().toISOString().slice(0, 10);
      const used = this.songUsage.get(day) || 0;
      if (used >= (this.cfg.song.dailyLimit ?? 5)) { decline('今天的歌曲生成额度已用完，这次未启动生成。'); return; }
      this.songUsage.clear();
      this.songUsage.set(day, used + 1);
    }
    const job = { id: randomUUID(), kind, spec, frame, chatKey: chat.key, userId: chat.userId,
      chat, generation, controller: new AbortController(), startedAt: Date.now(), state: 'queued',
      label: kind === 'document' ? `文档：${spec.topic || spec.kind}` : `歌曲：${spec.title || '新歌'}` };
    this.jobs.set(job.id, job);
    this.jobQueue.push(job);
    this.#drainJobs();
  }

  #drainJobs() {
    const limit = Math.min(4, Math.max(1, this.cfg.wecom.maxConcurrentJobs || 2));
    while (!this.stopped && this.runningJobs < limit && this.jobQueue.length) {
      const job = this.jobQueue.shift();
      if (job.controller.signal.aborted || !this.#current(job.generation)) { this.jobs.delete(job.id); continue; }
      this.runningJobs++;
      job.state = 'running';
      this.#runJob(job).finally(() => {
        this.runningJobs--;
        this.jobs.delete(job.id);
        this.#drainJobs();
      });
    }
  }

  async #runJob(job) {
    const valid = () => this.#current(job.generation) && !job.controller.signal.aborted && allowedWecom(job.chat, this.cfg.wecom)
      && (job.spec.kind !== 'inbox' || (this.documents?.isOwner(job.chatKey) && job.spec.accessGeneration === this.documents.generation));
    try {
      let result;
      if (!valid()) return;
      if (job.kind === 'song') result = await this.songGen.generate(job.spec);
      else {
        // Each background job gets its own builder and configuration snapshot.
        const office = this.officeFactory();
        const args = { ...job.spec, signal: job.controller.signal };
        if (job.spec.kind === 'inbox') result = await this.documents.buildSummary(job.spec, job.chatKey, job.controller.signal);
        else if (job.spec.kind === 'docx') result = await office.makeDocx(args);
        else if (job.spec.kind === 'excel') result = await office.makeExcel(args);
        else result = await office.makePpt({ ...args, withImages: true });
      }
      if (!valid()) return;
      await this.sender.sendFile(job.frame, result.file, result.name, {validate:valid});
      if (!valid()) return;
      this.documents?.delivered(result);
      this.documents?.rememberGenerated(job.chat, result);
      this.memory.append(job.chatKey, 'assistant', `[已完成并发送${job.kind === 'song' ? '歌曲' : '文档'}：${result.name || path.basename(result.file)}]`, job.chat.title);
    } catch {
      this.stats.errors++;
      if (valid()) {
        await this.sender.sendText(job.frame, `${job.kind === 'song' ? '歌曲' : '文档'}生成或发送失败了，请稍后再试。`).catch(() => {});
      }
    }
  }

  status() {
    return { ...this.stats, uptimeMs: Date.now() - this.stats.startedAt,
      jobs: [...this.jobs.values()].map(({ id, kind, label, state, startedAt }) => ({ id, kind, label, state, elapsedMs: Date.now() - startedAt })) };
  }
}
