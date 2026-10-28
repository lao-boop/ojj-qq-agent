import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STATE_FILE = path.join(DATA_DIR, 'games.json');
const IDIOM_FILE = path.join(DATA_DIR, 'knowledge', 'idioms.json');
const EXPIRE_MS = 2 * 60 * 60 * 1000;

const NUMBER_RANGE = 100;
const WIN_SCORE = 3;

const RPS = {
  石头: '剪刀',
  剪刀: '布',
  布: '石头',
  rock: '剪刀',
  scissors: '布',
  paper: '石头',
};

const DICE_WORDS = /^(掷|来|比|roll|摇|丢)/i;
const TURTLE = [
  {
    puzzle: '一个男人走进一家酒吧，对酒保说：“请给我一杯水。”酒保却突然掏出一把枪指着他。男人说“谢谢”，然后走了。为什么？',
    answer: '男人打嗝打不停，想喝水压一压；酒保用枪吓他，把他的打嗝吓停了，所以他道谢离开。',
  },
  {
    puzzle: '一个女人在葬礼上遇见一个男人，一见钟情。回家后她杀了自己的姐姐。为什么？',
    answer: '她想再办一次葬礼，好再见到那个男人。',
  },
  {
    puzzle: '一个人住在山顶的小屋里，半夜听到敲门声，开门却没人。他关门睡下，第二天发现山脚下有一具尸体。为什么？',
    answer: '敲门的是坠崖的人，抓住门把手求救；他一开门，对方就掉下去了。',
  },
  {
    puzzle: '一个女孩在家里听到广播说“本区发生命案，凶手在逃”，她立刻跑上楼躲进衣柜。为什么？',
    answer: '她家是殡仪馆/她躲在别人家；广播里的“家”不是她家——标准答案是：她是在别人家做客，广播让她意识到屋主可能是凶手。',
  },
];

const TWENTY = ['雨伞', '电饭煲', '仙人掌', '地铁', '风筝', '冰箱', '乒乓球', '灯塔', '邮票', '风筝线'];

const ADVENTURES = [
  '你在一座海边小城的旧书店里醒来，窗外在下雨，桌上有一封写着“别打开”的信。',
  '你是一名刚接到委托的赏金猎人，目标是城郊一座废弃的钟楼，据说里面每晚都有钟声。',
  '你在深夜的便利店值夜班，监控里出现了一个不该存在的人影，正站在你身后。',
];

function rand(n) {
  return Math.floor(Math.random() * n);
}

function pick(list) {
  return list[rand(list.length)];
}

export class GameHub {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.state = this.#load();
    this.idioms = null;
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 0), 'utf8');
    } catch (err) {
      this.logger?.warn?.(`保存游戏状态失败：${err.message}`);
    }
  }

  #tip(chatKey) {
    const cur = this.state[chatKey];
    if (cur && Date.now() - (cur.updatedAt || 0) > EXPIRE_MS) delete this.state[chatKey];
    return this.state[chatKey] || null;
  }

  #set(chatKey, type, data) {
    this.state[chatKey] = { type, data, updatedAt: Date.now() };
    this.#save();
  }

  #clear(chatKey) {
    delete this.state[chatKey];
    this.#save();
  }

  active(chatKey) {
    return Boolean(this.#tip(chatKey));
  }

  #idiomBank() {
    if (this.idioms) return this.idioms;
    try {
      const list = JSON.parse(fs.readFileSync(IDIOM_FILE, 'utf8'));
      const byFirst = new Map();
      for (const w of list) {
        const ch = w[0];
        if (!byFirst.has(ch)) byFirst.set(ch, []);
        byFirst.get(ch).push(w);
      }
      this.idioms = { list, byFirst, set: new Set(list) };
    } catch {
      this.idioms = { list: [], byFirst: new Map(), set: new Set() };
    }
    return this.idioms;
  }

  help() {
    return [
      '现在能玩的：',
      '· 猜数字 · 猜拳 · 掷骰子 · 成语接龙',
      '· 海龟汤 · 二十问 · 文字冒险',
      '说名字就开一局，说「不玩了」就退出。',
    ].join('\n');
  }

  /** 用户这句话是不是要开局/看菜单。返回要发的话，没有就返回空串。 */
  tryStart(chatKey, text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (/^(不玩了|退出游戏|结束游戏|不玩啦|quit)$/i.test(t)) {
      if (this.active(chatKey)) {
        this.#clear(chatKey);
        return '好，不玩了。想再来的话说「玩个游戏」就行。';
      }
      return '现在也没在玩呀，想玩就说「玩个游戏」。';
    }
    if (/^(玩个?游戏|游戏厅|有什么游戏|能玩什么|玩什么)/.test(t)) {
      return this.help();
    }

    let type = '';
    if (/猜数字/.test(t)) type = 'number';
    else if (/猜拳|石头剪刀布/.test(t)) type = 'rps';
    else if (/骰子/.test(t)) type = 'dice';
    else if (/成语接龙|接龙/.test(t)) type = 'idiom';
    else if (/海龟汤/.test(t)) type = 'turtle';
    else if (/二十问|20问/.test(t)) type = 'twenty';
    else if (/文字冒险|跑团|冒险游戏/.test(t)) type = 'adventure';
    if (!type) return '';
    return this.#start(chatKey, type);
  }

  #start(chatKey, type) {
    if (type === 'number') {
      this.#set(chatKey, type, { secret: 1 + rand(NUMBER_RANGE), tries: 0 });
      return `猜数字：我想了一个 1~${NUMBER_RANGE} 的整数，你猜，我会说「大了 / 小了」。最多 10 次。`;
    }
    if (type === 'rps') {
      this.#set(chatKey, type, { you: 0, me: 0 });
      return '猜拳：出「石头 / 剪刀 / 布」，先赢 3 局。';
    }
    if (type === 'dice') {
      this.#set(chatKey, type, { you: 0, me: 0 });
      return '掷骰子：说「掷」，比大小，先赢 3 局。';
    }
    if (type === 'idiom') {
      const bank = this.#idiomBank();
      if (!bank.list.length) return '成语库没加载上，先玩别的吧。';
      const first = pick(bank.list);
      const need = first[first.length - 1];
      this.#set(chatKey, type, { used: [first], need, rounds: 0 });
      return `成语接龙：我先来「${first}」。你接一个以「${need}」开头的四字成语，接不上说「放弃」。`;
    }
    if (type === 'turtle') {
      const p = pick(TURTLE);
      this.#set(chatKey, 'turtle', { puzzle: p.puzzle, answer: p.answer });
      return `海龟汤：${p.puzzle}\n\n你可以问我只能答「是 / 否 / 无关」的问题；想放弃就说「揭晓」。`;
    }
    if (type === 'twenty') {
      const secret = pick(TWENTY);
      this.#set(chatKey, 'twenty', { secret });
      return '二十问：我想好了一样东西，你来问，我只能答「是 / 否 / 接近」。猜到了直接说答案，想放弃说「揭晓」。';
    }
    if (type === 'adventure') {
      const scene = pick(ADVENTURES);
      this.#set(chatKey, 'adventure', { scene });
      return `文字冒险开始：${scene}\n你想怎么做？`;
    }
    return '';
  }

  /** 处理游戏中的一句话。返回 { reply } 或 { prompt } 或 null。 */
  handle(chatKey, text) {
    const cur = this.#tip(chatKey);
    if (!cur) return null;
    const t = String(text || '').trim();
    if (!t) return null;
    const type = cur.type;
    const data = cur.data || {};

    if (type === 'number') {
      const m = t.match(/\d{1,3}/);
      if (!m) return { reply: '说个数字呀，1~100。' };
      const n = Number(m[0]);
      if (!(n >= 1 && n <= NUMBER_RANGE)) return { reply: `要 1~${NUMBER_RANGE} 之间的数哦。` };
      data.tries = (data.tries || 0) + 1;
      if (n === data.secret) {
        this.#clear(chatKey);
        return { reply: `对了！就是 ${n}，你猜了 ${data.tries} 次。还想玩就说「猜数字」。` };
      }
      if (data.tries >= 10) {
        const answer = data.secret;
        this.#clear(chatKey);
        return { reply: `十次啦，没猜中。答案是 ${answer}。想再来一局说「猜数字」。` };
      }
      this.#set(chatKey, type, data);
      return { reply: `${n} ${n > data.secret ? '大了' : '小了'}。还剩 ${10 - data.tries} 次。` };
    }

    if (type === 'rps') {
      const you = Object.keys(RPS).find((k) => t.includes(k));
      if (!you) return { reply: '出「石头」「剪刀」或「布」。' };
      const me = pick(['石头', '剪刀', '布']);
      const youWin = RPS[you] === me;
      const tie = you === me;
      if (!tie) {
        if (youWin) data.you++;
        else data.me++;
      }
      if (data.you >= WIN_SCORE || data.me >= WIN_SCORE) {
        const win = data.you > data.me;
        this.#clear(chatKey);
        return {
          reply: `我出${me}，你出${you}。${tie ? '平局' : youWin ? '你赢' : '我赢'}！最终 ${data.you}:${data.me}，${win ? '你赢啦' : '我赢啦'}～`,
        };
      }
      this.#set(chatKey, type, data);
      return { reply: `我出${me}，你出${you}，${tie ? '平局' : youWin ? '你赢' : '我赢'}。比分 ${data.you}:${data.me}。` };
    }

    if (type === 'dice') {
      if (!DICE_WORDS.test(t)) return { reply: '说「掷」就开。' };
      const you = 1 + rand(6);
      const me = 1 + rand(6);
      if (you > me) data.you++;
      else if (me > you) data.me++;
      if (data.you >= WIN_SCORE || data.me >= WIN_SCORE) {
        const win = data.you > data.me;
        this.#clear(chatKey);
        return { reply: `你 ${you}，我 ${me}。最终 ${data.you}:${data.me}，${win ? '你赢啦' : '我赢啦'}～` };
      }
      this.#set(chatKey, type, data);
      return { reply: `你 ${you}，我 ${me}，${you > me ? '你赢这局' : me > you ? '我赢这局' : '平局'}。比分 ${data.you}:${data.me}。` };
    }

    if (type === 'idiom') {
      if (/放弃|接不上|不会|认输/.test(t)) {
        const bank = this.#idiomBank();
        const need = data.need;
        const options = (bank.byFirst.get(need) || []).filter((w) => !(data.used || []).includes(w));
        const sample = options.slice(0, 2).join('、') || '这个字开头的我也没有了';
        const first = pick(bank.list);
        this.#set(chatKey, 'idiom', { used: [first], need: first[first.length - 1], rounds: 0 });
        return { reply: `这轮算你放弃～可以接：${sample}。重新开一局：我先来「${first}」，接「${first[first.length - 1]}」。` };
      }
      const word = (t.match(/[\u4e00-\u9fa5]{4}/) || [])[0];
      if (!word) return { reply: '接一个四字成语呀。' };
      const bank = this.#idiomBank();
      if (!bank.set.has(word)) return { reply: `「${word}」我这儿查不到，换一个成语？` };
      if (word[0] !== data.need) return { reply: `要接「${data.need}」开头的哦。` };
      if ((data.used || []).includes(word)) return { reply: '这个刚用过啦，换一个。' };
      data.used = [...(data.used || []), word];
      const need = word[word.length - 1];
      const options = (bank.byFirst.get(need) || []).filter((w) => !data.used.includes(w));
      data.rounds = (data.rounds || 0) + 1;
      if (!options.length) {
        this.#clear(chatKey);
        return { reply: `「${word}」接得好，我这边接不上了，你赢！` };
      }
      const next = pick(options);
      data.used.push(next);
      data.need = next[next.length - 1];
      if (data.rounds >= 8) {
        this.#clear(chatKey);
        return { reply: `「${word}」→ 我接「${next}」。连着接了 ${data.rounds} 轮，够厉害了，这局算你赢～` };
      }
      this.#set(chatKey, 'idiom', data);
      return { reply: `我接「${next}」，该你接「${data.need}」了。` };
    }

    if (type === 'turtle' || type === 'twenty' || type === 'adventure') {
      if (/揭晓|答案|放弃|不猜了/.test(t)) {
        this.#clear(chatKey);
        if (type === 'turtle') return { reply: `揭晓：${data.answer}` };
        if (type === 'twenty') return { reply: `我想的是「${data.secret}」。` };
        return { reply: '这局先到这儿，想继续就说「文字冒险」。' };
      }
      if (type === 'turtle') {
        return {
          prompt: `[游戏：海龟汤] 谜面：${data.puzzle}\n答案（绝对不要主动说）：${data.answer}\n对方在问是非题。你只能回答「是」「否」「无关」，最多加半句提示；不要解释、不要剧透。`,
        };
      }
      if (type === 'twenty') {
        return {
          prompt: `[游戏：二十问] 你想的是「${data.secret}」。对方在猜，你只回答「是」「否」「接近」，不要说出答案；对方直接猜对时再承认。`,
        };
      }
      return {
        prompt: `[游戏：文字冒险] 背景：${data.scene}\n根据对方的选择继续剧情：2~4 句，给 2~3 个选项，保持连贯；不要跳出游戏、不要总结。`,
      };
    }

    return null;
  }
}
