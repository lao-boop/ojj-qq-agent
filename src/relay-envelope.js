import { parseWhen } from './wecom-relay.js';

/** Identify the envelope of an explicitly addressed text message before routing its body. */
export function readRelayEnvelope(text, recipients) {
  const raw = String(text || '').trim();
  const known = [...new Set(recipients)].filter(Boolean).sort((a, b) => b.length - a.length);
  const draft = /(?:草稿|起草|拟稿|拟一(?:条|版)|先写好|先给我过目|等我审核)/;
  const stop = /(?:取消这条|作废|撤回|暂缓|暂停发送|(?:别|不用|不要)(?:再|立即|现在)?(?:发|转|传|通知|告诉))/;
  const route = /(?:发给|传给|转给|转发给|告知|转告|转达给|同步给|告诉|通知|给|向|跟|在|和)/;
  const marks = [...raw.matchAll(/[：:，,]/g)].filter(m => !(/\d/.test(raw[m.index-1]||'') && /\d/.test(raw[m.index+1]||'')));
  for (const mark of [...marks,{index:raw.length}]) {
    const head = raw.slice(0,mark.index).trim();
    const body = raw.slice(mark.index+1).trim();
    // A comma can introduce another part of the instruction or another addressee.
    if (/[，,]/.test(mark[0]||'') && (/^(?:转告|发消息|通知|说)[：:]/.test(body) ||
        known.some(n => body.startsWith(n) && /^[，,:：、]/.test(body.slice(n.length))))) continue;
    if (!route.test(head) && !known.includes(head) && !draft.test(head) && !stop.test(head)) continue;
    const hits = known.filter(n => head.includes(n) && !known.some(long => long!==n && long.includes(n) && head.includes(long)));
    // In an unpunctuated “告诉张三不要发给客户”, the prohibition belongs to the message.
    const controlIndex = head.search(new RegExp(draft.source+'|'+stop.source));
    if (controlIndex >= 0 && hits.some(n => head.indexOf(n) < controlIndex) &&
        /^(?:请|帮我|麻烦)?(?:发给|告诉|转告|通知)/.test(head)) return null;
    if ((draft.test(head)||stop.test(head)) && (!hits.length && marks.length && mark.index < marks.at(-1).index)) continue;
    if (draft.test(head) && (route.test(head) || hits.length || /草稿|起草/.test(head))) return {reply:body?'草稿：'+body+'\n尚未发送。':'草稿要写什么内容？'};
    if (stop.test(head)) return {reply:'已停止，本条不会发送。'};
    if (/(?:还是|或者|或|没(?:有)?(?:确定|选好)|不确定)/.test(head) && hits.length)
      return {reply:'请确认收件对象：要发给哪位员工或哪个群？'};
    if (!hits.length) continue;
    // The target must finish the address; text already following it is not a new envelope.
    const last = Math.max(...hits.map(n=>head.lastIndexOf(n)+n.length));
    if (!/^[\s，,]*(?:的(?:所有|全体)员工)?(?:发(?:个消息|条消息|消息|一句话|通知)|带(?:个话|句话|一句)|捎句话|传话|说(?:一下|一声)?|转告|通知)?$/.test(head.slice(last))) continue;
    if (!route.test(head) && !known.includes(head)) continue;
    if (/(?:名单|成员|有谁|谁在)/.test(head) || /(?:取消|撤销)定时/.test(head)) continue;
    const first = Math.min(...hits.map(n=>head.indexOf(n)));
    const prefix = head.slice(0,first).trim();
    if (prefix && !/(?:发给|传给|转给|转发给|告知|转达给|同步给|转告|告诉|通知(?:一下)?|给|向|跟|在|和)$/.test(prefix)) continue;
    if (prefix.endsWith('在') && prefix !== '在') continue;
    if (/^(?:把|将)|(?:加到|加入|移出|移到)$/.test(prefix) && !/(?:发给|转给|传给)$/.test(prefix)) continue;
    // Preserve membership statements such as “张三在宣传组”.
    if (hits.length>1) {
      const ordered = [...hits].sort((a,b)=>head.indexOf(a)-head.indexOf(b));
      if (ordered.slice(1).some((n,i)=>!/^\s*(?:和|及|与|、|,|，)\s*$/.test(
        head.slice(head.indexOf(ordered[i])+ordered[i].length,head.indexOf(n))))) continue;
    }
    return {head,body,names:hits.sort((a,b)=>head.indexOf(a)-head.indexOf(b))};
  }
  return null;
}

/** 员工私聊中，以指令部分确定收件人和发送时间。正文保留原文。 */
export function readEmployeeBossRelay(text, aliases, now = new Date()) {
  const input = String(text ?? '').trimStart();
  const endOfAddress = /^(?:[ \t]*[，,:：][ \t]*|\s+|$)/;
  for (const alias of [...aliases].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const at = input.indexOf(alias);
    if (at < 0) continue;
    const prefix = input.slice(0, at).trimEnd();
    const after = input.slice(at + alias.length);
    const direct = /(?:转发给|发给|传给|转给|通知|转告|告诉|提醒)(?:一下)?$/.exec(prefix);
    const indirect = /(?:给|跟|向|和)$/.exec(prefix);
    const verb = direct || indirect;
    if (prefix && !verb) continue;

    let tail = after;
    if (!direct && indirect) {
      const speech = /^\s*(?:带个话|带句话|捎句话|传话|发个消息|发条消息|发消息|说一声|说一下|说)/.exec(after);
      if (!speech) continue;
      tail = after.slice(speech[0].length);
    }
    const boundary = endOfAddress.exec(tail);
    // Common unpunctuated dictation. An alias alone is not a relay command inside another name.
    if (!boundary && !(verb && /^(?:请|这份|附件|[\p{Script=Han}]{1,8}组|明天|今天|后天|周[一二三四五六日天]|我已|我想|我们|能否)/u.test(tail))) continue;

    // Only the words before the relay verb can specify a delivery time.
    const lead = verb ? prefix.slice(0, verb.index).trim() : '';
    const timeText = lead.replace(/^(?:麻烦你|麻烦|请|帮我|替我|劳烦|帮忙)+/, '')
      .replace(/(?:再|帮我|替我|直接|立即|现在)+$/, '').trim();
    let dueAt = null;
    if (timeText) {
      const when = parseWhen(timeText, now);
      if (!when) continue;
      const rest = timeText.replace(when.dateText, '').replace(when.timeText, '').trim();
      if (rest && rest !== '在') continue;
      if (when.at <= now.getTime()) return { reply: '这个发送时间已过，请确认什么时候发给老板。' };
      dueAt = when.at;
    }
    return { body: tail.slice(boundary?.[0].length ?? 0), dueAt, addressedByName: !verb };
  }
  return null;
}
