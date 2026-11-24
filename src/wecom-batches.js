import {sourcedAmount} from './wecom-rollup.js';

export const asksBatchTotal = q => /批/u.test(q) && !/分别|各(?:自|有|收)|差|缺|够不够|还是|[；;]/u.test(q) && /合计|合起来|合并|一共|总共|总数|加起来|总量|加在一起/u.test(q);

// Only narrow a single explicitly named matter. Leave comparisons and elliptical
// follow-ups to the existing thread/continuity resolver.
export function explicitMatter(q) {
  if (/分别|相比|对比|以及|和.{2,16}(?:两处|两地|各自)/u.test(q)) return '';
  const m = /^(?:关于|针对|请查|请核对)?[「“《]?([^，,：:。！？?的」”》]{2,40}?)[」”》]?(?:的|[，,：:])/u.exec(q.trim());
  return m && !/[和与、]|(?:刚才|上次|以前|昨天|之前)/u.test(m[1]) ? m[1] : '';
}

const ordinals = ['零','一','二','三','四','五','六','七','八','九','十'];
const batchPattern = /第([一二两三四五六七八九十]|\d+)批|首批/gu;
const amountPattern = /(?<![\d.负减−-])(\d+(?:\.\d{1,3})?)\s*(公斤|千克|小时|工时|千米|平方米|份|件|箱|包|台|本|张|套|盒|个|卷|册|组|枚|辆|瓶|袋|吨|米|斤|元|页|块|支)(?![\p{L}]*[每/])/gu;
const uncertain = /发出|发货|退库数量|待发|待收|借出|申请了|预计|预估|各约|大约|暂估|计划|目标|上限|至少|不少于|未到|未收|没收|尚未|待确认|作废|撤回|取消|退回|退货|退了|不含|其中|另有|可能|备选|假设|还没|如果|是否|[？?]/u;

// Preserve ordinal-to-amount bindings when a single employee reports several batches.
function receiptLines(text) {
  if ([...text.matchAll(batchPattern)].length < 2) return [text];
  if (uncertain.test(text)) return [text];
  const clauses=text.split(/[，,。；;\n]+/u).filter(Boolean);
  const rows=clauses.filter(c=>[...c.matchAll(batchPattern)].length);
  if (rows.some(c=>[...c.matchAll(batchPattern)].length!==1 || [...c.matchAll(amountPattern)].length!==1) ||
      clauses.some(c=>!rows.includes(c) && [...c.matchAll(amountPattern)].length)) return [text];
  return rows;
}

// A single unambiguous signed receipt can be rendered without another inference.
export function receiptAmount(report, sources) {
  if (!report.exactMatter || sources.length!==1) return null;
  const [source]=sources;
  const text=source.text.split('\n[该消息引用')[0];
  const hits=[...text.matchAll(amountPattern)];
  if (hits.length!==1 || uncertain.test(text) || !/实收|签收|点收|实点/u.test(text)) return null;
  const [,literal,unit]=hits[0];
  const value=sourcedAmount(text,literal,unit);
  if (!Number.isSafeInteger(value)) return null;
  return {text:report.exactMatter+'实收 '+value/1000+' '+unit+'。'+
    (source.name||source.sender)+'的消息：“'+text+'”',ids:[source.id]};
}

export function batchTotal(question, report, sources) {
  const unclear = reason => ({text:'暂不能确认合计：'+reason+'。',ids:[]});
  if (!report.exactMatter) return unclear('还需确认完整的事项和批次范围');
  const ledger = new Map(), sourceBatch = new Map();
  for (const source of sources) {
    const original = source.text.split('\n[该消息引用')[0];
    const lines = receiptLines(original);
    for (const text of lines) {
      const marks = [...text.matchAll(batchPattern)];
      let amounts = [...text.matchAll(amountPattern)];
      // An explicit replacement can quote the superseded amount in the same message.
      const revised = /(?:更正为|修正为|应为|改为|以)([0-9]+(?:\.[0-9]+)?\s*[\p{Script=Han}]+)(?:为准)?/u.exec(text);
      if (amounts.length>1 && revised && marks.length<=1) {
        const effective = amounts.filter(m=>m.index>=revised.index && m.index<revised.index+revised[0].length);
        if (effective.length===1 && /原报|误报|更正|修正|之前报|此前报/u.test(text)) amounts=effective;
      }
      if (!amounts.length && !/批|更正|修正|重报|撤回|作废|数量|点收/u.test(text)) continue;
      if (uncertain.test(text) || amounts.length!==1 || marks.length>1 ||
          !/实收|收到|点收|清点|到货|入库|验收|更正|改为|实点|签收|实到|复核/u.test(text))
        return unclear('原话中的实收数量或变更范围仍有歧义');
      const mark = marks[0], linked = report.links.find(l=>l.reply===source.id && l.basis==='平台引用编号');
      const batch = mark ? (mark[0]==='首批' ? 1 : Number(mark[1]) || ordinals.indexOf(mark[1].replace('两','二'))) : sourceBatch.get(linked?.quoted);
      if (!(batch>0)) return unclear('有一条报数没有可核实的批号');
      const [,literal,unit] = amounts[0];
      const value = sourcedAmount(text,literal,unit), prior = ledger.get(batch);
      if (prior && (prior.unit!==unit || (prior.value!==value && !/更正|修正|改为|纠正|以.{0,16}为准/u.test(text))))
        return unclear('同批报数冲突，需确认有效数量和单位');
      if (prior && prior.value!==value && prior.source.sender!==source.sender && sourceBatch.get(linked?.quoted)!==batch)
        return unclear('跨员工更正缺少可核实的承接依据');
      if (lines.length===1) sourceBatch.set(source.id,batch);
      if (!prior || prior.value!==value) ledger.set(batch,{batch,value,unit,source});
    }
  }
  const rows = [...ledger.values()].sort((a,b)=>a.batch-b.batch);
  const count = /([两二三四五六七八九十]|\d+)(?:批|回|趟|次)/u.exec(question)?.[1];
  const expected = Number(count) || ordinals.indexOf(count?.replace('两','二'));
  if (rows.length<2 || rows.some((r,i)=>r.batch!==i+1) || (expected>0 ? rows.length!==expected : !sources.some(s=>/最后一批|全部到齐|全部收齐/u.test(s.text))))
    return unclear('尚未核齐所问批次');
  if (rows.some(r=>r.unit!==rows[0].unit)) return unclear('各批单位不同，请确认换算口径');
  const sum = rows.reduce((n,r)=>n+r.value,0), unit=rows[0].unit;
  if (!Number.isSafeInteger(sum)) return unclear('数量超出可精确核算范围');
  return {text:report.exactMatter+'合计 '+sum/1000+' '+unit+'。'+rows.map(r=>
    '第'+r.batch+'批 '+r.value/1000+' '+unit+'（'+(r.source.name||r.source.sender)+'）').join('，')+'。',
    ids:[...new Set(rows.map(r=>r.source.id))]};
}
