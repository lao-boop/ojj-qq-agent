// Closed-form reconciliation for numbered receipts. An unfamiliar row invalidates
// the whole calculation so a partial sum is never presented as a verified total.
export function reconcileReceipts(subject, records, question) {
  const duplicateQuestion=/复印联|重复联|副联/u.test(question);
  if (!records.length || (!duplicateQuestion && !/净数|合计|有效实绩|总共|总数|净额|累计|总量/u.test(question))) return null;
  const scope = question.replace(/(?:核完|核对完|扣除|扣掉|剔除|去除|去掉)(?:了)?(?:重复联|重复单|撤单|撤销单|作废单)(?:以后|之后|后)/gu,'');
  if (/昨日|昨天|上周|截至|截止|之前|之后|以后|以来|期间|按人|各人|分别按|只算|排除|除了/u.test(scope)) return null;
  const receipts = new Map();
  const changes = [];
  const duplicates = new Set();
  let unit;
  const idPattern = /\b[A-Z]{1,10}-?\d{2,12}\b/gu;
  for (const r of records) {
    if (r.extractedText || r.imageReading || r.messageType !== 'text') return null;
    const body = r.text.replace(subject,'').replace(/^[\s。；，,:：]+|[。；，,\s]+$/gu,'');
    const ids = body.match(idPattern) || [];
    if (!ids.length && /(?:预计|计划|预估)/u.test(body) && /未实施|尚未发生|无实绩单|尚未执行/u.test(body) && !/但|其中|实际已/u.test(body)) continue;
    if (ids.length !== 1) return null;
    const id = ids[0];
    const numbers = body.replace(id,'').match(/\d+(?:\.\d+)?/gu) || [];
    const match = /^(?:补单|单号|编号)?[A-Z]{1,10}-?\d{2,12}[，,：:\s]+([^，,:：。；\d]{1,20}?)(?:实际投入|实际换好|实际查毕|实际发放|实际签收|实际完成|实际领取|发出|签收|领用|入库|发放|交付)(\d+)([\p{L}]{1,5})(?:[，,](?:本单已登记|凭证已入档|已登记|已核实))?$/u.exec(body);
    if (match) {
      if (/未|计划|预计|尚|待|拟|取消|撤销|如果|假设/u.test(match[1]) || receipts.has(id) || numbers.length!==1 || !Number.isSafeInteger(Number(match[2]))) return null;
      if (unit && unit!==match[3]) return null;
      unit=match[3];
      receipts.set(id,{group:match[1],amount:Number(match[2]), original:Number(match[2])});
    } else {
      if (!receipts.has(id)) return null;
      changes.push({id,body,numbers});
    }
  }
  if (!receipts.size) return null;
  for (const {id,body,numbers} of changes) {
    const receipt=receipts.get(id);
    if (!receipt) return null;
    const detail=body.slice(body.indexOf(id)+id.length);
    if (/^(?:整笔|全笔)撤销[，,](?:实绩为零|记零)$/u.test(detail)) receipt.amount=0;
    else if (/^(?:的)?(?:复印联|副联)补到[，,]同一笔[，,]原数/u.test(detail) &&
      detail.endsWith(numbers[0]+unit) && numbers.length===1) {
      duplicates.add(id);
      if (Number(numbers[0])!==receipt.original && Number(numbers[0])!==receipt.amount) return null;
    } else if (/^单据已复核[，,]无改动$/u.test(detail)) continue;
    else {
      const correction=/^原录入(多|少)记(\d+)(\p{L}+)[，,]实数应为(\d+)(\p{L}+)$/u.exec(detail);
      if (!correction || correction[3]!==unit || correction[5]!==unit ||
          receipt.amount+(correction[1]==='多'?-1:1)*Number(correction[2])!==Number(correction[4])) return null;
      receipt.amount=Number(correction[4]);
    }
  }
  if (duplicateQuestion && !/各组|合计|总量|净数/u.test(question)) {
    const ids=[...duplicates].filter(id=>!question.match(idPattern) || question.includes(id));
    if (!ids.length) return null;
    return ids.map(id=>id+' 的复印联与原单是同一笔，只记一次；该单核对后的实绩为 '+receipts.get(id).amount+unit+'。').join('\n');
  }
  const totals=new Map();
  for (const {group,amount} of receipts.values()) totals.set(group,(totals.get(group)||0)+amount);
  const sum=[...totals.values()].reduce((a,b)=>a+b,0);
  if (!Number.isSafeInteger(sum)) return null;
  const detail=[...totals].map(([name,n])=>name+' '+n+unit).join('，');
  const asked = [...totals.keys()].filter(name=>question.includes(name));
  const subtotal = asked.length===1 && !/各组|两组|全部|全体/u.test(question);
  const result = subtotal ? asked[0]+'净数 '+totals.get(asked[0])+unit : detail+'；各组合计 '+sum+unit;
  return subject+'按已登记的单号核对：'+result+'。重复联不重计，撤销记零，更正与补单已按记录核对，未实施的计划不计。';
}
