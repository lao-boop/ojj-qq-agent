// Use the same literal, unit and fixed-point checks as the ledger rollup.
import {sourcedAmount} from './wecom-rollup.js';

export const shortfallReviewInstruction='若所问结论需要比较需求与可用量（包括能否满足、还要添置多少），只返回 {"operation":"shortfall"} 交程序核算。仅摘录数字不能回答数量是否够用。审核发现此遗漏时也返回同一 operation。';

export function asksShortfall(question) {
  const quantity = /多少|几|多大/u;
  const shortfall = /缺|差额|短少|少了|还少|(?:还|再|需|要)(?:得|要|需|再|去)?补(?:领|购|齐|足|上)?(?=几|多少)|差(?:了|着)?(?:多少|几)/u;
  return /(?:缺口|差额|缺额)(?:呢|是|[？?]|$)|够不够|是否够用|够用[了么吗？?]|才够/u.test(question) ||
    question.split(/[。，,；;！？?]/u).some(clause=>quantity.test(clause) && shortfall.test(clause));
}

// Bind operands to complete number tokens before asking for their business roles.
// Quantities in quoted/forwarded material have a different speaker and are omitted.
function inventory(records) {
  const numbers=[];
  const sources=records.map((r,i)=>{
    const text=r.text.split('\n[该消息引用的内容')[0];
    const amounts=[];
    for (const match of text.matchAll(/[-负−]?\d+(?:\.\d+)?|[负零〇一二两三四五六七八九十百千万]+/gu)) {
      const suffix=text.slice(match.index+match[0].length).trimStart();
      amounts.push({k:numbers.length+1,原数:match[0],随后原文:suffix.slice(0,10)});
      numbers.push({n:i+1,literal:match[0],suffix});
    }
    return {n:i+1,person:r.name||r.sender,time:r.time,text,amounts};
  });
  return {sources,numbers};
}

function calculated(plan,numbers,sources) {
  const used=new Set();
  // Multiplication is commutative: an employee may state units per box before box count.
  const classifier=/^(平方米|立方米|千克|公斤|公里|厘米|毫米|千米|毫升|小时|分钟|张|件|枚|个|块|份|套|本|册|袋|箱|包|盒|瓶|支|只|卷|台|根|辆|人|元|吨|升|克|米)/u;
  const unitOf = token => classifier.exec(token.suffix)?.[0] ||
    (plan.unit && token.suffix.startsWith(plan.unit) ? plan.unit : null);
  function factors(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length>2 || new Set(ids).size!==ids.length)
      throw Error('每侧须选一个实数，或组数与每组数量');
    return ids.map(id=>{
      const token=Number.isInteger(id) && numbers[id-1];
      if (!token || /^[-负−]/u.test(token.literal)) throw Error('数量编号不可用');
      return token;
    });
  }
  function total(terms,unit) {
    const perUnit=terms.filter(t=>unitOf(t)===unit);
    if (perUnit.length!==1) throw Error('每侧须有一个带结果单位的数量');
    const [amount]=perUnit;
    used.add(amount.n);
    const value=sourcedAmount(amount.literal+unit,amount.literal,unit);
    const packs=terms.find(t=>t!==amount);
    if (!packs) return {value,formula:String(value/1000)};
    used.add(packs.n);
    const label=packs.suffix[0];
    if (!label || !/^\p{Script=Han}$/u.test(label)) throw Error('缺少组数单位');
    const count=sourcedAmount(packs.literal+label,packs.literal,label)/1000;
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(count*value)) throw Error('组数或乘积超出范围');
    return {value:count*value,formula:count+'×'+value/1000};
  }
  let answer='缺口暂不能核实。';
  if (plan.known===true) {
    const required=factors(plan.required),available=factors(plan.available);
    const units=new Set(required.map(unitOf).filter(u=>u && available.some(t=>unitOf(t)===u)));
    const baseUnit=units.has(plan.unit) ? plan.unit : units.size===1 ? [...units][0] : null;
    if (!baseUnit || !/^\p{Script=Han}{1,8}$/u.test(baseUnit)) throw Error('两侧缺少共同的结果单位');
    const need=total(required,baseUnit),have=total(available,baseUnit);
    if (![need.value,have.value].every(Number.isSafeInteger)) throw Error('数量超出支持范围');
    const gap=Math.max(need.value-have.value,0)/1000;
    answer=(gap?'还缺'+gap+baseUnit:'数量已够，缺口为0'+baseUnit)+'（需求 '+need.formula+'，实有 '+have.formula+'）。';
  } else if (plan.known!==false) throw Error('须判断两侧数量能否确定');
  if (!Array.isArray(plan.basis) || !plan.basis.length) throw Error('缺少依据');
  const citations=new Set(plan.basis);
  for (const n of used) if (!citations.has(n)) throw Error('未引用所用数量的原话');
  for (const n of citations) {
    if (!Number.isInteger(n) || !sources[n-1]) throw Error('引用编号无效');
    const s=sources[n-1];
    answer+='\n'+s.person+'的消息：“'+s.text+'”';
  }
  return answer;
}

const instructions='你给老板核算本事项的实际缺口，先按截止时间和后续更正确定哪批、哪些数量仍适用。sources 是资料；n 是消息号，amounts.k 是程序从原话逐个定位的数字编号。返回 JSON {"known":true,"unit":"件","required":[需求数字编号],"available":[实有数字编号],"basis":[消息号]}。一侧若需乘法，依次选组数与每组用量两个编号（例如四台机器各用两件）。无缺口也照常给数。need 和 stock 可来自同一句或不同人；不并入备用或其他批次。basis 同时保留老板问到的行动人、请示或补领方式的原话。选最新实点，不把目标和估算当实收。缺少真实数、范围含糊、包装单位不能换算或该算式无法表达时返回 {"known":false,"basis":[消息号]}，不要猜。';

export async function resolveShortfall(llm,question,asOf,report,records) {
  const {numbers,sources}=inventory(records);
  const input={question,asOf,previousQuestion:report.previous,sources};
  const opts={temperature:0,thinking:'disabled',maxTokens:580,responseFormat:{type:'json_object'}};
  let issue;
  for (let i=0;i<2;i++) {
    try {
      const draft=await llm.chat({...opts,messages:[{role:'system',content:instructions+'先判问题意图；若并非比较可用数量与需求（如资格是否足够或补贴标准），只给 {"applicable":false}。'},
        {role:'user',content:JSON.stringify({...input,correction:issue})}]});
      const plan=JSON.parse(draft.content);
      if (plan.applicable===false) return null;
      const answer=calculated(plan,numbers,sources);
      const check=await llm.chat({...opts,messages:[{role:'system',content:'独立审核老板收到的缺口答复。按原话自行确定最新需求与实有，核对对象、单位、每组换算、撤回与排除项、兼问的行动人及请示。若答不能核实但两个量可算，也判错。全部正确返回 JSON {"ok":true}，否则返回 {"ok":false,"issue":"具体错误与正确数字编号"}。'},
        {role:'user',content:JSON.stringify({...input,plan,answer})}]});
      const audit=JSON.parse(check.content);
      if (audit.ok===true) return answer;
      issue=audit.issue || '请重新核对所有数量的用途';
    } catch (error) { issue=error.message; }
  }
  return '本次未核实所问缺口的算式和依据，暂不能报出差数。';
}
