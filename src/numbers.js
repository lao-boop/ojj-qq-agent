// Read-only arithmetic and constraint checks. Decimal inputs remain exact
// fractions; expressions never enter eval/Function or any host-code interpreter.
const LIMIT = 512n;
function fraction(n, d = 1n) {
  if (!d) throw new Error('除数不能为0；基数为0时不能计算通常的增长率');
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b) [a, b] = [b, a % b];
  n /= a; d /= a;
  if ((n < 0n ? -n : n).toString(2).length > Number(LIMIT) || d.toString(2).length > Number(LIMIT)) throw new Error('计算数值过大');
  return { n, d };
}
function decimal(value) {
  if (typeof value !== 'string' || !/^[+-]?\d{1,18}(?:\.\d{1,18})?$/.test(value)) throw new Error('数值必须是普通十进制字符串');
  const [whole, tail = ''] = value.replace(/^[+-]/, '').split('.');
  return fraction(BigInt(whole + tail) * (value.startsWith('-') ? -1n : 1n), 10n ** BigInt(tail.length));
}
function operate(a, op, b) {
  if (op === '+') return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
  if (op === '-') return fraction(a.n * b.d - b.n * a.d, a.d * b.d);
  if (op === '*') return fraction(a.n * b.n, a.d * b.d);
  return fraction(a.n * b.d, a.d * b.n);
}
function parse(expression) {
  if (typeof expression !== 'string' || expression.length > 512 || !expression.trim()) throw new Error('算式为空或过长');
  const source = expression.replace(/[×＊]/g, '*').replace(/[÷／]/g, '/').replace(/[−－]/g, '-').replace(/（/g, '(').replace(/）/g, ')');
  const tokens = source.match(/\d+(?:\.\d+)?|[()+*/%\-]|\S/g) || [];
  if (tokens.length > 200) throw new Error('算式过于复杂');
  let i = 0;
  function primary(depth) {
    if (depth > 24) throw new Error('算式嵌套过深');
    let value, t = tokens[i++];
    if (t === '+' || t === '-') {
      value = primary(depth + 1); if (t === '-') value = fraction(-value.n, value.d);
    } else if (t === '(') {
      value = sum(depth + 1); if (tokens[i++] !== ')') throw new Error('算式括号不匹配');
    } else value = decimal(t);
    if (tokens[i] === '%') { i++; value = fraction(value.n, value.d * 100n); }
    return value;
  }
  function product(depth) {
    let value = primary(depth);
    while (tokens[i] === '*' || tokens[i] === '/') { const op = tokens[i++]; value = operate(value, op, primary(depth)); }
    return value;
  }
  function sum(depth) {
    let value = product(depth);
    while (tokens[i] === '+' || tokens[i] === '-') { const op = tokens[i++]; value = operate(value, op, product(depth)); }
    return value;
  }
  const result = sum(0);
  if (i !== tokens.length) throw new Error('只支持十进制数、加减乘除、百分号和括号');
  return result;
}
function display(value, digits = 8) {
  const scale = 10n ** BigInt(digits), abs = value.n < 0n ? -value.n : value.n;
  let q = abs * scale / value.d;
  if ((abs * scale % value.d) * 2n >= value.d) q++;
  const str = q.toString().padStart(digits + 1, '0');
  let result = digits ? `${str.slice(0, -digits)}.${str.slice(-digits)}` : str;
  if (digits) result = result.replace(/\.?0+$/, '');
  return `${value.n < 0n && q ? '-' : ''}${result}`;
}
export function calculate(expression, digits = 8) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) throw new Error('小数位数必须在0到12之间');
  const value = parse(expression);
  return { expression, result: display(value, digits), exact: value.d === 1n ? String(value.n) : `${value.n}/${value.d}`, rounded: (value.n * 10n ** BigInt(digits)) % value.d !== 0n };
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error(`${label}缺失或过长`);
  return value;
}
function compare(actual, rule) {
  const op = rule.operator;
  if (!['<=','>=','<','>','==','!='].includes(op)) throw new Error('条件运算符不支持');
  // Recover exact JSON boolean literals only. Never use Boolean(value), which
  // would turn "false" into true, or infer missing/ambiguous attributes.
  const booleanLiteral = value => value === 'true' ? true : value === 'false' ? false : value;
  const expected = booleanLiteral(rule.value);
  if (typeof expected === 'boolean') {
    if (!['==','!='].includes(op)) throw new Error('是否条件只支持等于或不等于');
    if (actual == null) return { status: 'unknown' };
    actual = booleanLiteral(actual);
    if (typeof actual !== 'boolean') throw new Error('是否条件的属性值必须是布尔值或null');
    return { status: (op === '==' ? actual === expected : actual !== expected) ? 'pass' : 'fail', actual };
  }
  const limit = parse(rule.value);
  if (actual == null) return { status: 'unknown', limit: display(limit) };
  const a = parse(actual), delta = operate(a, '-', limit), sign = delta.n < 0n ? -1 : delta.n > 0n ? 1 : 0;
  const passes = { '<=':sign <= 0, '>=':sign >= 0, '<':sign < 0, '>':sign > 0, '==':sign === 0, '!=':sign !== 0 }[op];
  return { status: passes ? 'pass' : 'fail', actual: display(a), limit: display(limit), difference: display(delta), exactDifference: delta.d === 1n ? String(delta.n) : `${delta.n}/${delta.d}` };
}
export function verifyNumbers(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('缺少核算参数');
  const calculations = args.calculations ?? [];
  if (!Array.isArray(calculations) || calculations.length > 16) throw new Error('每次最多核算16个算式');
  // An undefined growth rate does not discard other independently valid results.
  const results = calculations.map(c => {
    const label = text(c.label, '计算名称');
    try { return { label, ...calculate(c.expression, c.digits ?? 8) }; }
    catch (error) { return { label, expression: String(c.expression ?? '').slice(0, 512), error: error.message }; }
  });
  let decision;
  if (args.decision !== undefined) {
    const { constraints, options, recommendation } = args.decision || {};
    if (!Array.isArray(constraints) || !constraints.length || constraints.length > 12 || !Array.isArray(options) || !options.length || options.length > 20) throw new Error('需要1至12个明确条件和1至20个候选方案');
    for (const rule of constraints) { text(rule.field, '条件名称'); compare(null, rule); }
    const seen = new Set();
    const checked = options.map(option => {
      const label = text(option.label, '方案名称');
      if (seen.has(label)) throw new Error('方案名称不能重复'); seen.add(label);
      if (!option.values || typeof option.values !== 'object' || Array.isArray(option.values)) throw new Error('缺少方案属性');
      const checks = constraints.map(rule => ({ field: rule.field, operator: rule.operator, ...compare(Object.hasOwn(option.values, rule.field) ? option.values[rule.field] : null, rule) }));
      return { label, status: checks.some(c => c.status === 'fail') ? 'rejected' : checks.some(c => c.status === 'unknown') ? 'unknown' : 'eligible', checks };
    });
    const eligible = checked.filter(o => o.status === 'eligible').map(o => o.label);
    if (recommendation != null && !eligible.includes(recommendation)) throw new Error('推荐方案未通过全部硬性条件；不能推荐不合格或信息未知的方案');
    decision = { options: checked, eligible, recommendation: recommendation ?? null, conclusion: eligible.length ? '只能从eligible中的方案推荐；优先级依用户要求决定。' : '没有已确认满足全部条件的方案，不得擅自放宽条件。' };
  }
  if (!calculations.length && !decision) throw new Error('需要算式或候选方案条件');
  return { calculations: results, ...(decision ? { decision } : {}), basis: '仅核对传入的数据与条件；未核实来源。未知属性不能视为满足条件。' };
}

const scalar = { anyOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'null' }] };
export const NUMBER_TOOL = { type: 'function', function: {
  name: 'verify_numbers',
  description: '只读精确核算与硬条件筛选。金额/差额/百分比/数量计算必须使用，不心算。所有数值用十进制字符串或加减乘除括号百分号算式。条件和数据取自当前用户及已确认上下文，采用最新更正，包含运费等总成本；缺失属性用null，不能猜。筛选必须传decision列全所有硬条件和候选项，可再传calculations求差额；只在合格方案中按用户偏好选，皆不合格就说明。算式失败或除零不得编造结果。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    calculations: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, expression: { type: 'string' }, digits: { type: 'integer', minimum: 0, maximum: 12 } }, required: ['label','expression'] } },
    decision: { type: 'object', additionalProperties: false, properties: {
      constraints: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string' }, operator: { type: 'string', enum: ['<=','>=','<','>','==','!='] }, value: { anyOf: [{ type: 'string' }, { type: 'boolean' }] } }, required: ['field','operator','value'] } },
      options: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, values: { type: 'object', additionalProperties: scalar } }, required: ['label','values'] } },
      recommendation: { type: 'string', description: '可选，拟推荐的候选项名称；不符合全部条件将报错。' },
    }, required: ['constraints','options'] },
  } },
} };
