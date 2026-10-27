import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { formatGlobal } from './global.js';

const STATE_FILE = path.join(DATA_DIR, 'qzone-state.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * QQ 空间：发说说（可配图）+ 自动回复评论。
 * 依赖 SnowLuma 的扩展动作：send_qzone_msg / get_qzone_msg_list / get_qzone_msg_detail / comment_qzone
 */
export class Qzone {
  constructor({ onebot, cfg, llm, imageGen, logger, selfId, persona, memory }) {
    this.onebot = onebot;
    this.cfg = cfg || {};
    this.llm = llm;
    this.imageGen = imageGen;
    this.logger = logger;
    this.selfId = String(selfId || '');
    this.persona = persona || '';
    this.memory = memory || null;
    this.state = this.#loadState();
    this.timers = [];
    this.busy = false;
  }

  updateConfig(cfg) {
    this.cfg = cfg || {};
  }

  get enabled() {
    return Boolean(this.cfg?.enabled);
  }

  #loadState() {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      return { replied: [], lastPostAt: 0, lastPostTid: '', posts: {} };
    }
  }

  #saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      this.logger.warn(`保存空间状态失败：${err.message}`);
    }
  }

  async #call(action, params) {
    return this.onebot.call(action, params, 120000);
  }

  /** 发一条说说，返回 { tid, time }。 */
  async post({ content, imagePath, ugcRight } = {}) {
    const text = String(content || '').trim();
    if (!text) throw new Error('说说内容不能为空');
    const images = imagePath ? [`file:///${imagePath.replace(/\\/g, '/')}`] : [];
    const res = await this.#call('send_qzone_msg', {
      content: text,
      images,
      ugc_right: ugcRight ?? this.cfg.ugcRight ?? 1,
    });
    const tid = res?.tid || '';
    this.state.lastPostAt = Date.now();
    this.state.lastPostTid = tid;
    const day = new Date().toISOString().slice(0, 10);
    this.state.posts[day] = (this.state.posts[day] || 0) + 1;
    this.#saveState();
    this.logger.info(`说说已发布：${tid}（${images.length ? '带图' : '纯文字'}）`);
    return { tid, time: res?.time, text, withImage: images.length > 0 };
  }

  /** 让模型写一条说说 + 一句配图描述。 */
  async compose() {
    const now = new Date();
    const timeText = now.toLocaleString('zh-CN', { hour12: false });
    let raw = '';
    try {
      const res = await this.llm.chat({
        messages: [
          {
            role: 'system',
            content:
              `${this.persona}\n\n` +
              '你要发一条 QQ 空间说说（不是聊天回复）。要求：1~2 句，口语、有画面感，符合你的人设，别像广告，别带话题标签，最多一个表情。\n' +
              '另外给一句英文的配图描述（画面具体、适合文生图，不要出现文字）。\n' +
              '只输出 JSON：{"text":"说说正文","image":"english image prompt"}',
          },
          { role: 'user', content: `现在是 ${timeText}。想一条你现在想发的内容。` },
        ],
        maxTokens: 900,
        temperature: 0.95,
      });
      raw = String(res.content || '').trim();
    } catch (err) {
      this.logger.warn(`生成说说内容失败：${err.message}`);
    }

    const parse = (text) => {
      if (!text) return { text: '', imagePrompt: '' };
      let jsonText = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const m = jsonText.match(/\{[\s\S]*\}/);
      if (m) jsonText = m[0];
      try {
        const obj = JSON.parse(jsonText);
        return { text: String(obj.text || '').trim(), imagePrompt: String(obj.image || '').trim() };
      } catch {
        const first = text.split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).find((s) => s.length >= 4);
        return { text: (first || '').slice(0, 120), imagePrompt: '' };
      }
    };

    let out = parse(raw);
    if (!out.text) {
      this.logger.warn(`说说内容为空（原始长度 ${raw.length}），用兜底文案`);
      const fallback = [
        '海边的风今天有点甜，想分你一半。',
        '刚看到一朵云，形状像一条笨笨的鲸鱼。',
        '今天也在认真发呆，顺便想你一下。',
      ];
      out = { text: fallback[Math.floor(Math.random() * fallback.length)], imagePrompt: 'a cute whale girl sitting by the sea at golden hour, soft watercolor' };
    }
    return out;
  }

  /** 生成配图（失败就不配图）。 */
  async makeImage(prompt) {
    if (!this.cfg.withImage) return '';
    const p = prompt || 'a soft watercolor scene of a whale girl by the seaside, warm light';
    try {
      const img = await this.imageGen.generate({ prompt: p, size: '768x768' });
      return img?.file || '';
    } catch (err) {
      this.logger.warn(`说说配图生成失败：${err.message}`);
      return '';
    }
  }

  /** 主动发一条（模型自己写内容 + 配图）。 */
  async postAuto({ topic } = {}) {
    if (this.busy) return null;
    this.busy = true;
    try {
      let text = '';
      let imagePrompt = '';
      if (topic) {
        text = String(topic).trim();
      } else {
        const composed = await this.compose();
        text = composed.text;
        imagePrompt = composed.imagePrompt;
      }
      if (!text) throw new Error('没写出内容');
      const imagePath = await this.makeImage(imagePrompt);
      return await this.post({ content: text, imagePath });
    } finally {
      this.busy = false;
    }
  }

  async list(num = 10) {
    const res = await this.#call('get_qzone_msg_list', { num });
    return res?.msglist || [];
  }

  async detail(tid) {
    return this.#call('get_qzone_msg_detail', { tid, num: 20 });
  }

  async comment(tid, content) {
    return this.#call('comment_qzone', { tid, content });
  }

  /** 把和这个人的私聊记忆拼成一段，供空间回复参考。 */
  #memoryBlock(uin) {
    if (!this.memory || !uin) return '';
    try {
      const ctx = this.memory.context(`private:${uin}`);
      const parts = [];
      if (ctx.summary) parts.push(`【之前聊过的】${ctx.summary}`);
      if (ctx.notes?.length) parts.push(`【你记得的事】${ctx.notes.slice(-8).join('；')}`);
      if (ctx.turns?.length) {
        const recent = ctx.turns
          .slice(-6)
          .map((t) => `${t.role === 'user' ? '对方' : '你'}：${String(t.content).slice(0, 60)}`)
          .join(' / ');
        parts.push(`【最近的聊天】${recent}`);
      }
      return parts.join('\n').slice(0, 1200);
    } catch {
      return '';
    }
  }

  /** 给新评论写回复。 */
  async composeReply(post, comment) {
    try {
      const memory = this.#memoryBlock(comment.uin);
      const res = await this.llm.chat({
        messages: [
          {
            role: 'system',
            content:
              `${this.persona}\n\n${formatGlobal()}\n\n` +
              '有人在你的 QQ 空间说说下面评论了。用 1 句话回他，口语、自然、像朋友聊天，不要客套，不要提 AI。' +
              '只输出回复正文，不要引号，不要解释。' +
              (memory
                ? `\n\n下面是你们之前在 QQ 私聊里的记忆，回复时可以自然地用上（别生硬复述，也别暴露“我记得你说过”这种机器感）：\n${memory}`
                : ''),
          },
          {
            role: 'user',
            content: `你的说说：${String(post.content || '').slice(0, 200)}\n${comment.name || comment.uin} 评论：${String(comment.content || '').replace(/\[em\][^\[]*\[\/em\]/g, '').slice(0, 200)}`,
          },
        ],
        maxTokens: 600,
        temperature: 0.9,
      });
      const text = String(res.content || '')
        .trim()
        .replace(/^["“]|["”]$/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 80);
      if (text) return text;
    } catch (err) {
      this.logger.warn(`生成评论回复失败：${err.message}`);
    }
    return ['嘿嘿，谢谢你呀～', '被你发现啦。', '嗯嗯，我也这么觉得～'][Math.floor(Math.random() * 3)];
  }

  /** 轮询自己的说说，回复新评论（每条只回一次）。 */
  async pollComments() {
    if (this.busy) return 0;
    this.busy = true;
    let replied = 0;
    try {
      const list = await this.list(5);
      this.logger.info(`检查空间评论：${list.length} 条说说`);
      for (const post of list.slice(0, 3)) {
        if (!post?.comment_num) continue;
        let detail;
        try {
          detail = await this.detail(post.tid);
        } catch (err) {
          this.logger.warn(`读取说说评论失败：${err.message}`);
          continue;
        }
        const comments = detail?.comments || [];
        if (comments.length) this.logger.info(`说说 ${post.tid} 有 ${comments.length} 条评论，待处理`);
        for (const c of comments) {
          // comment_id 只在单条说说内唯一，必须带 tid 一起做去重
          const key = `${post.tid}:${c?.comment_id}`;
          if (!c?.comment_id || this.state.replied.includes(key)) continue;
          if (String(c.uin) === this.selfId) continue;
          const reply = await this.composeReply(post, c);
          if (!reply) {
            this.logger.warn(`评论 ${key} 没生成出回复，跳过`);
            continue;
          }
          try {
            await this.comment(post.tid, reply);
            this.state.replied.push(key);
            if (this.state.replied.length > 500) this.state.replied = this.state.replied.slice(-300);
            this.#saveState();
            replied++;
            this.logger.info(`已回复空间评论：${c.name || c.uin} → ${reply}`);
            await sleep(2000);
          } catch (err) {
            this.logger.warn(`回复空间评论失败：${err.message}`);
          }
        }
        await sleep(1000);
      }
    } catch (err) {
      this.logger.warn(`检查空间评论失败：${err.message}`);
    } finally {
      this.busy = false;
    }
    return replied;
  }

  /** 今天还能发几条。 */
  canPostToday() {
    const limit = this.cfg.dailyLimit ?? 2;
    if (limit <= 0) return true;
    const day = new Date().toISOString().slice(0, 10);
    return (this.state.posts[day] || 0) < limit;
  }

  startAuto() {
    if (!this.enabled) return;
    const postEveryMs = Math.max(1, this.cfg.intervalHours ?? 8) * 3600 * 1000;
    const pollEveryMs = Math.max(3, this.cfg.pollMinutes ?? 10) * 60 * 1000;

    if (this.cfg.autoPost) {
      const tick = async () => {
        try {
          if (!this.canPostToday()) return;
          if (Date.now() - (this.state.lastPostAt || 0) < postEveryMs) return;
          const r = await this.postAuto();
          if (r) this.logger.info(`自动说说完成：${r.tid}`);
        } catch (err) {
          this.logger.warn(`自动说说失败：${err.message}`);
        }
      };
      this.timers.push(setTimeout(tick, 60 * 1000));
      this.timers.push(setInterval(tick, 30 * 60 * 1000));
    }

    if (this.cfg.replyComments) {
      this.timers.push(setTimeout(() => this.pollComments().catch(() => {}), 15000));
      this.timers.push(setInterval(() => this.pollComments().catch(() => {}), pollEveryMs));
    }
    this.logger.info(
      `空间功能已启动：主动发说说=${Boolean(this.cfg.autoPost)}（每 ${this.cfg.intervalHours}h，每天 ${this.cfg.dailyLimit} 条），回复评论=${Boolean(this.cfg.replyComments)}`,
    );
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
