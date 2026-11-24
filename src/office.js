import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, ROOT } from './config.js';
import { ffmpegBin } from './media.js';

const execFileAsync = promisify(execFile);
const DOCS_DIR = path.join(DATA_DIR, 'documents');

/** 从模型输出里抠出 JSON（容忍尾逗号、代码块）。 */
function parseJson(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  const attempt = (s) => JSON.parse(s);
  try {
    return attempt(text);
  } catch {
    const fixed = text.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    return attempt(fixed);
  }
}

// Only the first complete outline object belongs to the deck. The model may
// follow it with a second example or prose. Braces inside strings are data.
function firstOutlineObject(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  let depth = 0, quoted = false;
  for (let i = start; start >= 0 && i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '\\') { i++; continue; }
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return parseJson(text.slice(start, i + 1));
  }
  throw new Error('未收到完整的 JSON 大纲');
}

// A numbered instruction belongs to a physical page, independent of a model's section count.
function wordPagePlan(topic) {
  const total = topic.match(/(?:交付|总计|总共|共|严格|恰好|生成|一份|制作|写成|做成)\s*(\d{1,3})\s*(?:个)?(?:实际|打印|正文|物理)*页/);
  if (!total || !Number(total[1])) return null;
  const pages = Array.from({ length: Number(total[1]) }, (_, i) => ({ number: i + 1 }));
  const markers = [...topic.matchAll(/(?:^|[；;：:\n。])\s*(?:第\s*)?(\d+)\s*页\s*[：:、]?\s*/g)];
  for (const [i, marker] of markers.entries()) {
    const page = pages[Number(marker[1]) - 1];
    if (!page) throw new Error('指定页码超出要求的总页数');
    const instruction = topic.slice(marker.index + marker[0].length, markers[i + 1]?.index).trim().replace(/[。；;]+$/, '');
    const labeled = /^([^「“"\n]{1,80}?)\s*[「“"]([^」”"\n]+)[」”"]$/.exec(instruction);
    Object.assign(page, { instruction });
    if (labeled) Object.assign(page, { heading: labeled[1].trim(), phrase: labeled[2] });
  }
  return pages;
}

// Recognize a single explicitly enumerated series. Leave ambiguous prose,
// mixed units and multi-series charts to the outline model.
function requestedSeries(clause) {
  const list = clause.match(/(?:展示|呈现|对比|显示)\s*([^，,]*?(?:[、，,][^。；;]+))$/u)?.[1];
  if (!list) return null;
  const entries = list.trim().replace(/[，,、]\s*$/, '').split(/[、，,]/)
    .map(part => part.trim().match(/^([\p{L}\p{N}_ -]{1,18}?)\s*(?:[:：=]\s*|\s+)([-+]?\d+(?:\.\d+)?)\s*([\p{L}%％]*)$/u));
  if (entries.length < 2 || entries.length > 8 || entries.some(e => !e || e[3] !== entries[0][3])) return null;
  const categories = entries.map(e => e[1].trim());
  if (new Set(categories).size !== entries.length) return null;
  return { categories, series: [{ name: entries[0][3] || '数值', values: entries.map(e => Number(e[2])) }] };
}

/**
 * 办公文档生成：PPT / Word。
 * 内容由模型出大纲，排版由 scripts/build_office.py（python-pptx / python-docx）完成。
 */
export class Office {
  constructor({ cfg, llm, imageGen, logger, pythonPath }) {
    this.cfg = cfg || {};
    this.llm = llm;
    this.imageGen = imageGen;
    this.logger = logger;
    this.python = pythonPath || process.env.PYTHON_PATH || '';
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }

  updateConfig(cfg) {
    this.cfg = cfg || {};
  }

  #python() {
    const candidates = [
      this.python,
      this.cfg.pythonPath,
      process.env.PYTHON_PATH,
      path.join(process.env.LOCALAPPDATA || '', 'AstrBot', 'backend', 'python', 'python.exe'),
      path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return 'python';
  }

  /** 让模型分两批写大纲，避免一次输出太长被截断。 */
  async #askSlides({ topic, count, start, theme, previous = [], withHeader = false }) {
    const system =
      '你是专业的内容策划和 PPT 大纲作者。根据主题输出 JSON，结构：' +
      (withHeader ? '{"title":"主标题","subtitle":"副标题（一句话概括）","closingTitle":"封底文字","slides":[{"title":"页标题","bullets":["要点"],"imagePrompt":"english prompt"}]}' : '{"slides":[{"title":"页标题","bullets":["要点"],"imagePrompt":"english prompt"}]}') +
      '。' +
      `这次只写 ${count} 页正文（按成品页码，第 ${start + 1} 至 ${start + count} 页）；slides 数组只放正文。每页 3~4 条要点，每条 10~26 个汉字；` +
      '可选字段（按需，不要每页都加）：' +
      '"chart":{"type":"bar|line|pie","title":"标题（示意）","categories":["..."],"series":[{"name":"...","values":[1,2,3]}]}，最多 1 页且仅当适合数据对比；' +
      '"cards":[{"icon":"⚔","title":"四到六字","text":"一句话"}]，最多 1 页（总览/总结），3~4 张。' +
      '用户指定页码时，封面为第1页，正文第一页为第2页，封底单独输出为 closingTitle。用户明确要求的图表必须用 chart，保留原始分类、数值和图表类型；该页不要 cards。标题和封底指定文字必须逐字保留。' +
      '语言简体中文；不要 Markdown；不要输出 JSON 以外的任何文字。' +
      `风格：${theme || '历史纪实'}，严肃、有信息量。`;
    const user = [
      `主题：${topic}`,
      previous.length ? `前面已经写了：${previous.join('、')}。请接着往后写，不要重复。` : '',
    ]
      .filter(Boolean)
      .join('\n');

    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.llm.chat({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: lastErr ? `${user}\n上一版校验失败：${lastErr.message.slice(0, 180)}。请修正并输出完整 JSON。` : user },
          ],
          model: this.cfg.model || 'deepseek-flash',
          maxTokens: 6000,
          temperature: attempt === 1 ? 0.7 : 0.5,
        });
        const obj = firstOutlineObject(res.content);
        if (!Array.isArray(obj.slides) || obj.slides.length !== count) {
          throw new Error('slides 数组应恰好包含 ' + count + ' 页正文');
        }
        const slides = (obj.slides || []).map((s) => {
          const item = {
            title: String(s.title || '').slice(0, 60),
            bullets: (s.bullets || []).map((b) => String(b).slice(0, 80)).slice(0, 5),
            imagePrompt: String(s.imagePrompt || '').slice(0, 300),
          };
          if (s.cards && Array.isArray(s.cards) && s.cards.length) {
            item.cards = s.cards.slice(0, 4).map((c) => ({
              icon: String(c.icon || '◆').slice(0, 2),
              title: String(c.title || '').slice(0, 20),
              text: String(c.text || '').slice(0, 60),
            }));
          }
          if (s.chart && Array.isArray(s.chart.categories) && Array.isArray(s.chart.series)) {
            item.chart = {
              type: String(s.chart.type || 'bar'),
              title: String(s.chart.title || '').slice(0, 40),
              categories: s.chart.categories.map((c) => String(c).slice(0, 12)).slice(0, 8),
              series: s.chart.series.slice(0, 3).map((ser) => ({
                name: String(ser.name || '').slice(0, 20),
                values: (ser.values || []).map((v) => Number(v) || 0).slice(0, 8),
              })),
            };
          }
          return item;
        });
        for (const match of topic.matchAll(/第\s*(\d+)\s*页([^。；;]*?)(?=第\s*\d+\s*页|[。；;]|$)/g)) {
          const index = Number(match[1]) - start - 1;
          if (index < 0 || index >= count) continue;
          const chartType = match[2].match(/(柱状图|条形图|折线图|饼图)/)?.[1];
          if (!chartType) continue;
          const needed = { 柱状图: 'bar', 条形图: 'bar', 折线图: 'line', 饼图: 'pie' }[chartType];
          const explicit = requestedSeries(match[2]);
          if (explicit) slides[index].chart = { ...slides[index].chart, type: needed, ...explicit };
          const chart = slides[index].chart;
          if (chart?.type !== needed || !chart.categories.length || !chart.series.length) {
            throw new Error(`第 ${match[1]} 页缺少用户指定的${chartType}`);
          }
          delete slides[index].cards;
        }
        return { title: obj.title, subtitle: obj.subtitle, closingTitle: obj.closingTitle, slides };
      } catch (err) {
        lastErr = err;
        this.logger.warn(`大纲第 ${attempt} 次解析失败：${err.message}`);
      }
    }
    throw new Error(`大纲生成失败：${lastErr?.message || '未知错误'}`);
  }

  async #outlinePpt({ topic, pages, theme }) {
    const first = Math.ceil(pages / 2);
    const part1 = await this.#askSlides({ topic, count: first, start: 1, theme, withHeader: true });
    let slides = part1.slides || [];
    if (pages > first) {
      const part2 = await this.#askSlides({
        topic,
        count: pages - first,
        start: first + 1,
        theme,
        previous: slides.map((s) => s.title),
      });
      slides = slides.concat(part2.slides || []);
    }
    slides = slides.slice(0, pages);
    const closingPage = new RegExp('(?:第\\s*' + (pages + 2) + '\\s*页|封底|最后一页)\\s*(?:写上?|写明|注明|文字为|标题为|显示)\\s*[:：]?\\s*(?:“([^”]+)”|"([^"]+)")');
    const requested = closingPage.exec(topic);
    return {
      title: String(topic.match(/《([^》]+)》/)?.[1] || part1.title || topic).slice(0, 60),
      closingTitle: requested?.[1] || requested?.[2] || String(part1.closingTitle || '').slice(0, 80),
      subtitle: String(part1.subtitle || '').slice(0, 80),
      slides,
    };
  }

  async #wordJson(messages, validate, signal) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const res = await this.llm.chat({
        messages: lastError ? [...messages, { role: 'user', content: '上次结果无效：' + lastError.message + '。请按原要求重新返回完整 JSON。' }] : messages,
        model: this.cfg.model || 'deepseek-flash', maxTokens: 6000, temperature: 0.4,
        responseFormat: { type: 'json_object' }, directAnswer: true,
      });
      signal?.throwIfAborted();
      try {
        const obj = firstOutlineObject(res.content);
        validate(obj);
        return obj;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async #pagedWord(topic, pages, signal) {
    let title = topic.match(/《([^》]+)》/)?.[1];
    const sections = [];
    for (let start = 0; start < pages.length; start += 4) {
      const batch = pages.slice(start, start + 4);
      const messages = [
        { role: 'system', content: '你是企业方案作者。按所附页号撰写可直接交付的文档，只输出 JSON：{"title":"文档标题","pages":[{"number":1,"heading":"页标题","paragraphs":["背景与实施方法","落地步骤与检查办法"],"action":"负责人、执行动作和可检查的交付物"}]}。每个指定页号各写一项，顺序一致。每页正文约 200 至 350 个汉字。把给定业务条件落实到本页措施，不编造已完成的成果。若页面有指定短语，排版器会原样展示，正文无需重复列举。不得另设封面或将多页合成表格。' },
        { role: 'user', content: JSON.stringify({ request: topic, total: pages.length, previousHeadings: sections.map(s => s.heading), writePages: batch }) },
      ];
      const obj = await this.#wordJson(messages, result => {
        if (!Array.isArray(result.pages) || result.pages.length !== batch.length) throw new Error('实际页项目数量与本批要求不一致');
        for (const [i, page] of result.pages.entries()) {
          if (page?.number !== batch[i].number || typeof page.heading !== 'string' || !page.heading.trim()
            || !Array.isArray(page.paragraphs) || !page.paragraphs.length || !page.paragraphs.every(p => typeof p === 'string' && p.trim())
            || typeof page.action !== 'string' || !page.action.trim()) throw new Error('页号、页标题、正文或执行动作缺失');
          const text = [...page.paragraphs, page.action].join('');
          if (text.length < 40 || text.length > 550 || page.paragraphs.length > 4 || /[\r\n\f]/.test(text)) throw new Error('正文不适合单页排版，请使用 2 至 4 个简短段落，不插入换行');
        }
      }, signal);
      title ||= obj.title;
      for (const [i, page] of obj.pages.entries()) {
        sections.push({ heading: batch[i].heading || page.heading, requirement: batch[i].phrase,
          paragraphs: [...page.paragraphs, '执行动作：' + page.action], emphasis: ['执行动作：'] });
      }
    }
    return { title: String(title || '方案'), sections, paginated: true };
  }

  async #outlineDocx({ topic, sections, signal }) {
    const pages = wordPagePlan(topic);
    if (pages) return this.#pagedWord(topic, pages, signal);
    const obj = await this.#wordJson([
        {
          role: 'system',
          content:
            '你是专业的中文写作者。根据主题输出 JSON，结构：' +
            '{"title":"标题","subtitle":"副标题","sections":[{"heading":"小节标题","paragraphs":["段落"],"bullets":[],"table":{"headers":["列名"],"rows":[["值"]]}}]}。用户要求表格必须在相应小节输出 table，逐字保留表头、行顺序和单元格，不需要表格时省略该字段。引号内指定的摘要原样写入段落。' +
            '正文和列表默认常规字重。需要强调用户指定的重点或关键结论时，可在该节添加 emphasis 字符串数组，逐字引用正文或列表中的短语，不改动原文，不给整段加粗。' +
            `要求：${sections} 个小节；每节 1~2 段，每段 90~180 个汉字；语言简体中文；不要 Markdown；不要输出 JSON 以外的任何文字。`,
        },
        { role: 'user', content: `主题：${topic}` },
      ], result => {
        if (!Array.isArray(result.sections) || !result.sections.length || result.sections.some(s => !s || typeof s.heading !== 'string')) throw new Error('章节数组无效');
      }, signal);
    return {
      title: String(topic.match(/《([^》]+)》/)?.[1] || obj.title || topic).slice(0, 60),
      subtitle: String(obj.subtitle || '').slice(0, 80),
      sections: (obj.sections || []).slice(0, sections),
    };
  }

  async #build(spec, signal = this._signal) {
    const stamp = randomUUID();
    const ext = spec.kind;
    const file = path.join(DOCS_DIR, `${spec.kind}-${stamp}.${ext}`);
    const specPath = path.join(DOCS_DIR, `${spec.kind}-${stamp}.json`);
    fs.writeFileSync(specPath, JSON.stringify({ ...spec, out: file }, null, 2), 'utf8');
    try {
      await execFileAsync(this.#python(), [path.join(ROOT, 'scripts', 'build_office.py'), specPath], {
        timeout: 180000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        signal: signal || undefined,
      });
    } catch (err) {
      throw new Error(`生成失败：${String(err.stderr || err.message).slice(0, 200)}`);
    } finally {
      try {
        fs.unlinkSync(specPath);
      } catch {
        /* ignore */
      }
    }
    if (!fs.existsSync(file) || fs.statSync(file).size < 3000) throw new Error('生成失败：文件为空');
    return file;
  }

  /** 用现成的章节内容生成 Word（不经过大纲模型），用于汇总材料。 */
  async makeSummaryDocx({ title, subtitle = '', sections = [], theme = 'business' } = {}) {
    const cleanTitle = String(title || '汇总材料').slice(0, 60);
    const spec = {
      kind: 'docx',
      theme,
      title: cleanTitle,
      subtitle,
      author: '小安',
      sections: (sections || []).slice(0, 40),
    };
    const file = await this.#build(spec);
    const name = `${cleanTitle}.docx`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
    return { file, name, title: cleanTitle, sections: spec.sections.length };
  }

  /** 生成 PPT，返回 { file, name, title, pages }。 */
  async makePpt({ topic, pages = 12, theme = 'history', withImages = true, signal } = {}) {
    this._signal = signal || null;
    const started = Date.now();
    const total = topic.match(/(?:共|总计|总共|一份|制作|做|要)\s*(\d+)\s*页/);
    if (total && Number(total[1]) >= 3) pages = Math.min(20, Number(total[1]) - 2);
    const outline = await this.#outlinePpt({ topic, pages, theme });
    if (!outline.slides.length) throw new Error('大纲为空');

    if (withImages && this.imageGen) {
      const n = outline.slides.length;
      const contentIdx = [];
      for (let i = 0; i < n; i++) contentIdx.push(i); // 全是正文页（封面/封底不在这里）
      // 默认：除封面封底外，没有图的正文页不超过 2 张
      const auto = Math.max(1, n - 2);
      const maxImages = Math.min(this.cfg.imagesPerDeck > 0 ? this.cfg.imagesPerDeck : auto, n);
      const delay = this.cfg.imageDelayMs ?? 12000;

      const skippable = contentIdx.filter((i) => !outline.slides[i].cards && !outline.slides[i].chart);

      const picks = skippable.slice(0, maxImages);
      for (let k = 0; k < picks.length; k++) {
        const s = outline.slides[picks[k]];
        if (!s.imagePrompt) s.imagePrompt = `illustration for: ${s.title}, chinese historical documentary style, no text`;
        if (k > 0) await new Promise((r) => setTimeout(r, Math.max(delay, 15000)));
        if (!s.imagePrompt) continue;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const img = await this.imageGen.generate({ prompt: s.imagePrompt, size: 'square' });
            s.image = img.file;
            break;
          } catch (err) {
            const throttled = /429|throttl|rate limit/i.test(err.message);
            this.logger.warn(`配图失败（第 ${picks[k] + 1} 页，第 ${attempt} 次）：${err.message.slice(0, 80)}`);
            if (throttled && attempt < 3) {
              await new Promise((r) => setTimeout(r, 65000));
              continue;
            }
            break;
          }
        }
      }
    }

    const file = await this.#build({
      kind: 'pptx',
      theme,
      title: outline.title,
      subtitle: outline.subtitle,
      closingTitle: outline.closingTitle,
      slides: outline.slides,
    });
    const name = `${outline.title}-${outline.slides.length + 2}页.pptx`.replace(/[\\/:*?"<>|]/g, '_');
    this.logger.info(`PPT 完成：${name}，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, title: outline.title, pages: outline.slides.length + 2 };
  }

  /** 生成 Excel 表格，返回 { file, name, title, rows }。 */
  async makeExcel({ topic, rows = 10, columns = 5, signal } = {}) {
    this._signal = signal || null;
    const started = Date.now();
    const res = await this.llm.chat({
      messages: [
        {
          role: 'system',
          content:
            '你是数据整理助手。根据主题生成一张表格的 JSON：' +
            '{"title":"表格标题","sheets":[{"name":"工作表名","columns":["列1","列2"],"rows":[["值1","值2"]]}]}。' +
            `要求：1 个工作表，${columns} 列左右、${rows} 行左右；列名简洁；数据要合理（可以是示意数据，别写不确定的真实统计）；` +
            '工作表第1行为列名、第2行起为数据。需要计算时输出以等号开头的 Excel 公式，包括合计行，按实际行号引用。数字用数字类型；不要 Markdown；不要输出 JSON 以外的任何文字。',
        },
        { role: 'user', content: `主题：${topic}` },
      ],
      model: this.cfg.model || 'deepseek-flash',
      maxTokens: 4000,
      temperature: 0.6,
    });
    const obj = parseJson(res.content);
    const sheets = (obj.sheets || []).slice(0, 3).map((sh) => ({
      name: String(sh.name || 'Sheet1').slice(0, 28),
      columns: (sh.columns || []).map((c) => String(c).slice(0, 30)).slice(0, 10),
      rows: (sh.rows || []).slice(0, 60).map((r) => (r || []).slice(0, 10)),
    }));
    if (!sheets.length || !sheets[0].columns.length) throw new Error('表格内容为空');

    const file = await this.#build({
      kind: 'xlsx',
      headerFirst: true,
      theme: 'business',
      title: String(obj.title || topic).slice(0, 60),
      sheets,
    });
    const name = `${String(obj.title || topic).slice(0, 40)}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    this.logger.info(`Excel 完成：${name}，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, title: String(obj.title || topic), rows: sheets[0].rows.length };
  }

  /** 生成 Word，返回 { file, name, title, sections }。 */
  async makeDocx({ topic, sections = 5, signal } = {}) {
    const started = Date.now();
    const outline = await this.#outlineDocx({ topic, sections, signal });
    const file = await this.#build({
      kind: 'docx',
      theme: 'business',
      title: outline.title,
      subtitle: outline.subtitle,
      paginated: outline.paginated,
      sections: outline.sections,
    }, signal || null);
    const name = `${outline.title}.docx`.replace(/[\\/:*?"<>|]/g, '_');
    this.logger.info(`Word 完成：${name}，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, title: outline.title, sections: outline.sections.length };
  }
}
