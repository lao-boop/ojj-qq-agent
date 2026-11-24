const number = '[负+-]?[零〇一二两三四五六七八九十百千万亿0-9]+(?:[点.][零〇一二两三四五六七八九0-9]+)?';
const valueAndUnit = new RegExp(`^(${number})\\s*(.*)$`);
const knownUnit = /^(?:人民币|块钱|元|块|箱|件|套|台|份|个|盒|张|瓶|包|公斤|千克|毫米|厘米|mm|cm|年|月|日|号|点半|点钟|点|时|分钟|分|%)$/i;

function interpret(input, field) {
  const answer = input.trim().replace(/[。！!，,\s]+$/u, '');
  if (/^(取消|算了|先别处理|不用了)$/.test(answer)) return { cancel: true };
  const options = field.options;
  if (/^(是的|好的|嗯|对)$/.test(answer) && !options.includes(answer)) return null;
  if(field.open && /^(?:不知道|不清楚|听不清|没听清|稍等|等一下)$/u.test(answer))return null;
  const ordinal = /^(?:选|是)?(?:第([一二三四1-4])个?|([前后])一个)$/.exec(answer);
  if (ordinal) {
    const i = ordinal[1] ? ('一二三四'.indexOf(ordinal[1]) + 1 || Number(ordinal[1])) - 1
      : ordinal[2] === '前' ? 0 : options.length - 1;
    if (options[i]) return { value: options[i] };
  }
  const value = answer.replace(/^(?:都不是[，, ]*)?(?:(?:用词|地名|编号|名字|姓名|收件人|负责人|数量|金额|时间|日期)是|我说的是|应该是|改成|是)/, '');
  if (options.includes(value)) return { value };
  if (field.label === '用词') {
    const key = s => s.normalize('NFKC').replace(/\s/gu,'').toLowerCase();
    const option = options.find(o => /[a-z]/iu.test(key(o)) && key(o) === key(value));
    if (option) return {value:option};
  }
  if (field.open && /^[\p{Script=Han}a-z0-9·]{1,16}$/iu.test(value)) return {value};
  if (field.label === '编号') return value !== answer && /^[a-z0-9-]{2,20}$/i.test(value) ? { value } : null;
  if (field.label === '日期' && /^(?:周|星期|礼拜)[一二三四五六日天1-7]$/.test(value)) return { value };
  if (field.label === '用词' || field.label === '地名') {
    if (value !== answer && /^[\p{L}\p{N} ·%-]{1,16}$/u.test(value)) return { value };
    return null;
  }
  // A third spelling must be explicit so an unrelated group message cannot become a name.
  if (field.label === '名字' && /^[\p{Script=Han}·]{2,8}$/u.test(value)) {
    if (value !== answer && !/^(?:的|这个|那个)$/.test(value)) return { value };
  }
  if (field.label !== '名字') {
    const match = valueAndUnit.exec(value);
    const units = new Set(options.map(v => valueAndUnit.exec(v)?.[2]));
    if (match && knownUnit.test(match[2]) && units.has(match[2])) return { value };
    if (match && !match[2]) {
      const [unit] = units;
      if (units.size === 1 && unit) return { value: value + unit };
    }
  }
  return null;
}

export class VoiceClarifications {
  pending = new Map();

  answer(key, input) {
    const pending = this.pending.get(key);
    if (!pending) return false;
    const reply = interpret(input, pending.field);
    if (!reply) return false;
    pending.finish(reply.value ?? null);
    return true;
  }

  cancel(key) {
    this.pending.get(key)?.finish(null);
  }

  async confirm(key, transcript, fields, send, confirmed) {
    this.cancel(key);
    const chars = Array.from(transcript);
    const replacements = [];
    for (const field of fields) {
      const { start, end, options } = field;
      if (!Array.isArray(options) || options.length < (field.open?1:2) || chars.slice(start, end).join('') !== options[0]) {
        throw new Error('语音待确认字段与原文不一致');
      }
      let finish;
      const answered = new Promise(resolve => { finish = resolve; });
      const entry = { field, finish: value => {
        if (this.pending.get(key) !== entry) return;
        this.pending.delete(key);
        clearTimeout(timer);
        finish(value);
      } };
      const timer = setTimeout(() => entry.finish(null), 5 * 60 * 1000);
      this.pending.set(key, entry);
      const choices = options.map(o => `“${o}”`);
      try {
        const lead = field.label === '用词' ? '这处我没听清，你说的是' : `${field.label}我没听准，是`;
        const nearby=chars.slice(Math.max(0,start-6),Math.min(chars.length,end+6)).join('');
        const context=field.label==='用词' && nearby!==chars.slice(start,end).join('') ? `你说到“${nearby}”时，` : '';
        const prompt=field.open?`我听成了“${options[0]}”，这几个字能打给我吗？`:
          `${context}${lead}${choices.slice(0, -1).join('、')}还是${choices.at(-1)}？`+
          (field.label==='用词'?'都不对的话，直接打出那个词就行。':'');
        await send(prompt);
        const value = await answered;
        if (value === null) return null;
          replacements.push({ start, end, value, field });
      } finally {
        entry.finish(null);
      }
    }
    for (const { start, end, value, field } of replacements.reverse()) {
      chars.splice(start, end - start, value);
      confirmed?.(field, value);
    }
    return chars.join('');
  }
}

const actionRequest=/发给|转给|联系|通知|收件人|寄到|送到|导航|下单|订购|追加|报价|付款|转账|提醒我|取消|改期/;
const personalTitle=/(?:先生|女士|老师|主任|经理|教授|医生|师傅|师父|法师|和尚|律师|院士|导演)/u;
const surname=/^[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛范彭鲁韦马苗方任袁柳鲍史唐薛雷贺倪汤滕殷罗郝安常傅余齐顾孟黄穆萧尹姚邵汪毛狄戴宋庞熊纪舒董梁杜阮蓝闵贾娄江童郭梅林钟徐邱高夏蔡田樊胡凌霍虞万卢莫房丁邓洪包左石崔龚程邢裴陆翁甄封段焦侯牛耿曾刘肖叶廖谭欧]/u;
const polarity=/不得|不能|不要|禁止|拒绝|取消|未|不|没|无|别/gu;
const styleKey=s=>s.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu,'')
  .replace(/[她它]/gu,'他').replace(/([啊呀哦呃嗯呢啦]+)$/u,'')
  .replace(/(一点|有点|这会|一会|那会|没事|饭点)儿/gu,'$1')
  .replace(/(跑|唱|走|做|写|说|叫)[的得](?=好|快|慢|轻|响)/gu,'$1得');

// Rank only spans already flagged by ASR. The immediate context must show what
// fact would change. The number of hypotheses alone never triggers a question.
function impactPriority(text,field,options) {
  if(['名字','人名','地名'].includes(field.label)) return 3;
  if(field.label!=='用词') return 0;
  if(new Set(options.map(s=>(s.match(polarity)??[]).join(''))).size>1) return 4;
  const chars=Array.from(text);
  const left=chars.slice(Math.max(0,field.start-9),field.start).join('');
  const right=chars.slice(field.end,field.end+12).join('');
  const heard=options[0];
  // A title shared by the alternatives puts the disputed characters in the name.
  const title=personalTitle.exec(heard)?.[0];
  if(personalTitle.test(right.slice(0,3)) || (title && options.every(s=>s.endsWith(title)))) return 3;
  if(/(?:名叫|名为|姓名是|署名|负责人是|受访者是)$/u.test(left)) return 3;
  if(heard.includes('、') && heard.split('、').every(n=>/^[\p{Script=Han}]{2,4}$/u.test(n)) &&
     heard.split('、').some(n=>surname.test(n))) return 3;
  if(options.length>=3 && options.every(s=>s.length>=2 && s.length<=3 && surname.test(s) && s[0]===heard[0])) return 3;
  if(options.length>=3 && /^(?:与|和|及|于是|随后|表示|宣布|出席|出任|负责|将|又将)/u.test(right)) return 3;
  if(/(?:位于|途经|抵达|来自|运往|开往|[县镇乡])$/u.test(left) ||
     /^(?:[县镇乡村]|(?:铁路|公路|航空|水路|铁海|海铁)?(?:联运|口岸|港口|车站|机场))/u.test(right)) return 3;
  // A three-way disagreement in the predicate or object can change the event.
  if(options.length>=3 && /(?:将要|正在|开始|继续|已经|即将|计划|必须)$/u.test(left)) return 2;
  if(options.length>=3 && /(?:购买|运输|更换|拆除|取走|撬|砸|搬运|安装)/u.test(heard)) return 2;
  return 0;
}

export function conversationalFields(text, fields) {
  const required=[], candidates=[];
  for(const f of fields) {
    if(!['用词','名字','人名','地名'].includes(f.label)) {required.push(f);continue;}
    const raw=[...new Set((f.options??[]).map(s=>s.normalize('NFKC').replace(/\s/gu,'')))];
    if(new Set(raw.map(styleKey)).size<2 || raw.every(s=>/^[的地得]$/u.test(s))) continue;
    const chars=Array.from(text);
    const before=chars.slice(Math.max(0,f.start-12),f.start).join('').split(/[，。！？；]/u).at(-1);
    const after=chars.slice(f.end,f.end+6).join('').split(/[，。！？；]/u)[0];
    if(actionRequest.test(before+raw[0]+after)) {required.push(f);continue;}
    const priority=impactPriority(text,f,raw);
    if(priority) candidates.push({field:f,priority});
  }
  // At most one discretionary question per conversational turn.
  if(!required.length && candidates.length) {
    candidates.sort((a,b)=>b.priority-a.priority);
    required.push(candidates[0].field);
  }
  return required;
}

// Confirmation callbacks run from right to left, so original offsets remain
// valid while each earlier correction moves subsequent, unanswered fields.
export function shiftDeferredFields(fields,confirmed,value) {
  const delta=Array.from(value).length-(confirmed.end-confirmed.start);
  for(const f of fields) if(f.start>=confirmed.end) {f.start+=delta;f.end+=delta;}
}

export class VoiceFollowups {
  sessions = new Map();

  remember(key, text) {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (entry.expires <= now) this.sessions.delete(id);
    }
    this.sessions.set(key, { text, notes: [], awaiting: false, expires: now + 10 * 60_000 });
  }

  handle(key, input) {
    const entry = this.sessions.get(key);
    if (!entry || entry.expires <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    const line = input.trim().replace(/[。！!]+$/u, '');
    if (!line || line.startsWith('/')) return null;
    if (/^(?:(?:不对|不是)[，,、 ]*)?(?:你(?:刚才)?听错了?|刚才(?:那句)?听错了?|(?:人名|名字|地名|那个词)(?:听错了?|不对))$/.test(line)) {
      entry.awaiting = true;
      entry.awaitingName = /人名|名字/.test(line);
      return { question: '刚才听错的那处，应该怎么说？' };
    }
    const term = '([^，,。！？!?、\\s]{1,24})';
    const nameCue = /^(?:(?:我说的)?(?:人名|名字|姓名)(?:是|叫)|我叫)/u;
    const spelling = line.replace(/^(?:你听错了|名字不对|人名不对)[，,、 ]*/u,'').replace(nameCue,'是')
      .replace(/[，,。 ]*(?:帮我)?记住这个名字$/u,'');
    const wrongFirst = new RegExp('^不是' + term + '[，,、 ]*是' + term + '$','u').exec(spelling);
    const rightFirst = new RegExp('^是' + term + '[，,、 ]*不是' + term + '$','u').exec(spelling);
    const wrong = wrongFirst?.[1] ?? rightFirst?.[2];
    const right = wrongFirst?.[2] ?? rightFirst?.[1];
    const anchored = wrong && entry.text.includes(wrong);
    const explicit = /^(?:我(?:刚才)?说的是|地名是|那个词是|(?:你(?:刚才)?听错了?|(?:名字|人名|地名|那个词)(?:听错了?|不对))[，,、 ])/u.test(line);
    const briefAnswer = entry.awaiting && /^[\p{L}\p{N}· 的]{1,24}$/u.test(line)
      && !/[吗呢么]$|^(?:好的?|算了|取消|谢谢|不用了|换个话题)$/.test(line);
    entry.awaiting = false;
    const named = nameCue.test(line) || /记住这个名字$/.test(line) || entry.awaitingName;
    entry.awaitingName = false;
    if (!anchored && !explicit && !briefAnswer && !nameCue.test(line)) return null;
    if (anchored && entry.text.indexOf(wrong) === entry.text.lastIndexOf(wrong)) {
      entry.text = entry.text.replace(wrong, () => right);
    }
    entry.notes.push(line);
    const name = named ? (right ?? spelling.replace(/^(?:我说的是|是)/u,'')) : null;
    return { name, heard: anchored ? wrong : null, context: [
      '对方在纠正刚才的语音。结合下面的转写和补充，用最新说法接着回答原来的问题。若原来只是陈述，简短接话即可。',
      '语音内容：' + entry.text, '对方随后补充：' + entry.notes.join('；'),
    ].join('\n') };
  }
}
