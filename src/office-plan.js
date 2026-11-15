const fail = message => { throw new Error(message); };
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}必须是非空文字`);
  if (value.length > max) fail(`${label}过长（最多${max}字），请压缩正文并将细节移到备注`);
  return value.trim();
};
const list = (value, label, max) => {
  if (!Array.isArray(value) || !value.length || value.length > max) fail(`${label}必须包含1～${max}项`);
  return value;
};
const exampleRequested = source => /(?:示例|样例|模拟|虚构|sample)/i.test(source) && !/(?:不要|禁止|不能|不得).{0,5}(?:示例|模拟|虚构)/.test(source);
const numbers = source => String(source).replace(/[,，](?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
const hasNumber = (source, value) => numbers(source).some(n => Math.abs(n - value) < 1e-9);

export function validateDeck(obj, { count, source }) {
  const slides = list(obj.slides, '正文页', 24);
  if (slides.length !== count) fail(`需要恰好${count}页正文，当前为${slides.length}页`);
  const titles = new Set();
  const normalized = slides.map((s, index) => {
    const title = text(s.title, `第${index + 1}页标题`, 44);
    if (titles.has(title)) fail(`页标题重复：${title}`);
    titles.add(title);
    const item = { title, layout: s.layout || (s.cards ? 'cards' : s.chart ? 'chart' : s.table ? 'table' : s.comparison ? 'comparison' : s.steps ? 'timeline' : s.imagePrompt ? 'image' : 'bullets'),
      takeaway: s.takeaway ? text(s.takeaway, '本页结论', 48) : '',
      notes: typeof s.notes === 'string' ? s.notes : '',
      source: typeof s.source === 'string' ? s.source : '',
      imagePrompt: typeof s.imagePrompt === 'string' ? s.imagePrompt.trim() : '',
      bullets: (s.bullets || []).map(b => text(b, '要点', 100)) };
    if (!['bullets', 'cards', 'chart', 'comparison', 'timeline', 'table', 'image'].includes(item.layout)) fail('不支持的幻灯片版式');
    if (item.bullets.length > 5 || item.bullets.join('').length > 260) fail(`${title}正文过密`);
    if (item.layout === 'cards') item.cards = list(s.cards, '卡片', 4).map(c => ({ title: text(c.title, '卡片标题', 20), text: text(c.text, '卡片正文', s.cards.length === 4 ? 60 : 90) }));
    if (item.layout === 'comparison') item.comparison = list(s.comparison, '对比栏', 2).map(c => ({ title: text(c.title, '对比标题', 20), bullets: list(c.bullets, '对比要点', 4).map(v => text(v, '对比要点', 50)) }));
    if (item.layout === 'comparison' && item.comparison.length !== 2) fail('对比页需要两栏');
    if (item.layout === 'timeline') item.steps = list(s.steps, '流程/时间线', 5).map(c => ({ title: text(c.title, '步骤标题', 20), text: text(c.text, '步骤说明', s.steps.length >= 4 ? 50 : 80) }));
    if (item.layout === 'table') {
      const columns = list(s.table?.columns, '表头', 5).map(c => text(c, '表头', 16));
      const rows = list(s.table?.rows, '表格行', 6).map(r => {
        if (!Array.isArray(r) || r.length !== columns.length) fail('PPT表格行列不一致');
        return r.map(v => text(String(v ?? '待提供'), '表格内容', Math.max(16, Math.floor(140 / columns.length / Math.ceil((s.table.rows.length + 1) / 3)))));
      });
      item.table = { columns, rows };
    }
    if (item.layout === 'chart') {
      if (item.bullets.join('').length > 140) fail('图表旁的文字过密，请缩短至140字以内');
      const chart = s.chart;
      const categories = list(chart?.categories, '图表分类', 8).map(c => text(c, '分类名称', 20));
      const citation = String(chart.source || '');
      const example = exampleRequested(source) && chart.example === true;
      if (!example && (!citation || !source.includes(citation))) fail('图表必须引用用户材料中的真实数据原文；无数据时改用流程或定性对比');
      const series = list(chart.series, '图表系列', 3).map(ser => {
        if (!Array.isArray(ser.values) || ser.values.length !== categories.length) fail('图表分类与数值数量不一致，不允许补零');
        for (const v of ser.values) if (typeof v !== 'number' || !Number.isFinite(v) || (!example && !hasNumber(citation, v))) fail('图表存在无来源或无效数值');
        return { name: text(ser.name, '系列名称', 24), values: ser.values };
      });
      if (!['bar', 'line', 'pie'].includes(chart.type)) fail('图表类型仅支持bar/line/pie');
      if (chart.type === 'pie' && (series.length !== 1 || series[0].values.some(v => v < 0) || series[0].values.every(v => v === 0))) fail('饼图必须为一个非负且合计大于零的系列');
      item.chart = { type: chart.type, title: String(chart.title || title), categories, series };
      item.source = example ? '示例数据，非真实统计' : citation;
    }
    if (['bullets', 'image'].includes(item.layout) && !item.bullets.length) fail(`${title}缺少正文内容`);
    return item;
  });
  return { title: text(obj.title, '演示标题', 60), subtitle: String(obj.subtitle || ''),
    closing: String(obj.closing || '下一步行动与讨论'), slides: normalized };
}

const columnIndex = letter => !/^[A-Z]{1,2}$/.test(letter) ? -1 : [...letter].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
export function validateFormula(formula, { width, lastRow }) {
  if (typeof formula !== 'string' || !/^=[A-Z0-9$:.(),+*/\s-]+$/i.test(formula)) fail('公式只能使用本表单元格、数字、四则运算和受支持函数');
  for (const [, name] of formula.matchAll(/([A-Z_][A-Z0-9_.]*)\s*\(/gi)) {
    if (!['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'].includes(name.toUpperCase())) fail(`不支持的公式函数：${name}`);
  }
  for (const [, col, row] of formula.matchAll(/\$?([A-Z]{1,3})\$?(\d+)/gi)) {
    if (columnIndex(col.toUpperCase()) > width || Number(row) < 3 || Number(row) > lastRow) fail(`公式引用超出数据区域：${col}${row}`);
  }
  return formula;
}

export function validateWorkbook(obj, { source, requireFormula = false }) {
  const names = new Set();
  const sheets = list(obj.sheets, '工作表', 5).map(sh => {
    const name = text(sh.name || 'Sheet1', '工作表名', 31);
    if (/[\\/:*?\[\]]/.test(name) || names.has(name.toLowerCase())) fail('工作表名含非法字符或重名');
    names.add(name.toLowerCase());
    const definitions = list(sh.columns, '列', 20).map(c => typeof c === 'string' ? { header: c, type: 'auto' } : c);
    const columns = definitions.map(c => text(c.header, '列标题', 60));
    if (new Set(columns).size !== columns.length) fail('列标题不能重复');
    const columnTypes = definitions.map(c => c.type || 'auto');
    if (columnTypes.some(t => !['auto', 'text', 'integer', 'number', 'currency', 'percent', 'date'].includes(t))) fail('未知列类型');
    if (!['provided', 'template', 'example'].includes(sh.dataMode)) fail('工作表必须声明dataMode：provided/template/example');
    const inputRows = list(sh.rows, '数据行', 200);
    const example = sh.dataMode === 'example' && exampleRequested(source);
    if (sh.dataMode === 'example' && !example) fail('用户未要求示例数据，不能编造示例');
    const rowSources = sh.rowSources || [];
    const rows = inputRows.map((r, i) => {
      if (!Array.isArray(r) || r.length > columns.length) fail(`第${i + 1}行列数超出表头`);
      if (sh.dataMode === 'provided' && (!rowSources[i] || !source.includes(rowSources[i]))) fail(`第${i + 1}行缺少可核对的数据原文`);
      const row = [...r, ...Array(columns.length - r.length).fill(null)];
      for (const [j, v] of row.entries()) {
        if (['integer', 'number', 'currency', 'percent'].includes(columnTypes[j]) && v !== null && typeof v !== 'number' && !(typeof v === 'string' && v.startsWith('='))) fail('数值列必须填JSON数字、公式或null');
        if (columnTypes[j] === 'integer' && typeof v === 'number' && !Number.isInteger(v)) fail('整数列含小数');
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) fail('单元格不能包含对象或数组');
        if (typeof v === 'number' && (!Number.isFinite(v) || (!example && !hasNumber(rowSources[i] || source, v)))) fail(`第${i + 1}行存在原始材料中没有的数值：${v}；计算结果必须使用公式`);
      }
      return row;
    });
    for (const computed of sh.computedColumns || []) {
      const index = columnIndex(String(computed.column || '').toUpperCase()) - 1;
      if (index < 0 || index >= columns.length || typeof computed.formula !== 'string') fail('计算列定义无效');
      for (let i = 0; i < rows.length; i++) rows[i][index] = computed.formula.replace(/\{([A-Z]+)\}/gi, (_, col) => col.toUpperCase() + (i + 3));
    }
    if (sh.totals && Object.keys(sh.totals).length) {
      if (rows.some(r => ['合计', '总计'].includes(String(r[0])))) fail('totals已指定时，数据行中不能再手写合计行');
      const total = Array(columns.length).fill(null); total[0] = '合计';
      for (const [column, method] of Object.entries(sh.totals)) {
        const index = columnIndex(column.toUpperCase()) - 1, fn = String(method).toUpperCase();
        if (index <= 0 || index >= columns.length || !['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'].includes(fn)) fail('合计列或方法无效');
        total[index] = `=${fn}(${column.toUpperCase()}3:${column.toUpperCase()}${rows.length + 2})`;
      }
      rows.push(total);
    }
    for (const row of rows) for (const value of row) if (typeof value === 'string' && value.startsWith('=')) validateFormula(value, { width: columns.length, lastRow: rows.length + 2 });
    let chart;
    if (sh.chart) {
      const category = columnIndex(String(sh.chart.categoryColumn || '').toUpperCase());
      const values = (sh.chart.valueColumns || []).map(v => columnIndex(String(v).toUpperCase()));
      if (!['bar', 'line', 'pie'].includes(sh.chart.type) || category < 1 || category > columns.length || !values.length || values.some(v => v < 1 || v > columns.length)) fail('Excel图表引用的列无效');
      if (sh.chart.type === 'pie' && values.length !== 1) fail('饼图只能引用一个数值列');
      chart = { type: sh.chart.type, title: String(sh.chart.title || ''), category, values };
    }
    return { name, columns, columnTypes, rows, chart, example };
  });
  if (requireFormula && !sheets.some(sh => sh.rows.some(row => row.some(v => typeof v === 'string' && v.startsWith('='))))) fail('用户要求公式，但表格没有任何公式');
  return { title: text(obj.title, '表格标题', 60), sheets };
}
