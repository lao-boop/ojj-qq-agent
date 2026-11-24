// Keep the spelling from the published product name. A homophone on its own
// does not establish that the speaker is referring to the product.
const products = [
  {
    value: '京东E卡',
    source: 'https://help.jd.com/user/issue/287-488.html',
    pattern: /京东\s*[eEＥｅ一伊衣]\s*卡(?!通|多用|双号|车|顿)/gu,
    context: /礼品卡|购卡|绑卡|自营|京东.{0,5}首页/u,
  },
  {
    value: '健康随e保',
    source: 'https://www.jsw.com.cn/2019/0606/1496405.shtml',
    pattern: /健康随\s*[eEＥｅ意易伊一]\s*保(?!存|留|管|持|养|护)/gu,
    context: /投保|重疾|保单|保险产品|保险计划/u,
  },
  // "to" links the parties in a business model. Leave literal model numbers
  // and unrelated English phrases alone.
  ...[['P','P'],['B','B'],['B','C'],['C','C']].map(([from,to])=>({
    value: from+' to '+to,
    pattern: new RegExp('(?<![a-z0-9])'+from+'\\s+two\\s+'+to+'(?![a-z0-9])','giu'),
    context: /理财|借贷|电商|商业模式|交易平台|企业采购/u,
  })),
];

export const spellingKey = word => word.normalize('NFKC').toLowerCase().replace(/\s/gu, '');

export function resolveBusinessTerms(text, primary, confirmed = []) {
  const protectedWords = [...confirmed].filter(Boolean);
  for (const { value, pattern, context } of products) {
    const previous = text;
    text = text.replace(pattern, (heard, at) => {
      if (overlapsConfirmation(previous, at, heard.length, confirmed)) return heard;
      const key = spellingKey(value);
      const votes = primary.filter(line => spellingKey(line).includes(key)).length;
      if (spellingKey(heard) !== key && votes < 2 && !context.test(previous)) return heard;
      protectedWords.push(value);
      return value;
    });
  }
  // Department routing needs the correct card name. The alternative must
  // occur at this same service desk in an independent reading.
  const card = /[一伊]卡(?=\s*客服)/u.exec(text);
  let field;
  if (card && !overlapsConfirmation(text, card.index, card[0].length, protectedWords)) {
    const desk = /([一伊e])卡客服/u;
    const variants = new Set(primary.map(line => desk.exec(spellingKey(line))?.[1]).filter(Boolean));
    if (variants.size >= 2) {
      const start = [...text.slice(0, card.index)].length;
      field = {start, end:start + 2, label:'用词', options:[card[0], 'E卡']};
    }
  }
  return {text, protectedWords, field};
}

function overlapsConfirmation(text, start, length, words) {
  return words.some(word => {
    if (!word) return false;
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
      if (at < start + length && at + word.length > start) return true;
    }
    return false;
  });
}
