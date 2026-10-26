import fs from 'node:fs';
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
      (withHeader ? '{"title":"主标题","subtitle":"副标题（一句话概括）","slides":[{"title":"页标题","bullets":["要点"],"imagePrompt":"english prompt"}]}' : '{"slides":[{"title":"页标题","bullets":["要点"],"imagePrompt":"english prompt"}]}') +
      '。' +
      `这次只写 ${count} 页正文（第 ${start}~${start + count - 1} 页）；每页 3~4 条要点，每条 10~26 个汉字；` +
      '可选字段（按需，不要每页都加）：' +
      '"chart":{"type":"bar|line|pie","title":"标题（示意）","categories":["..."],"series":[{"name":"...","values":[1,2,3]}]}，最多 1 页且仅当适合数据对比；' +
      '"cards":[{"icon":"⚔","title":"四到六字","text":"一句话"}]，最多 1 页（总览/总结），3~4 张。' +
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
            { role: 'user', content: user },
          ],
          model: this.cfg.model || 'deepseek-flash',
          maxTokens: 6000,
          temperature: attempt === 1 ? 0.7 : 0.5,
        });
        const obj = parseJson(res.content);
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
        return { title: obj.title, subtitle: obj.subtitle, slides };
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
    return {
      title: String(part1.title || topic).slice(0, 60),
      subtitle: String(part1.subtitle || '').slice(0, 80),
      slides,
    };
  }

  async #outlineDocx({ topic, sections }) {
    const res = await this.llm.chat({
      messages: [
        {
          role: 'system',
          content:
            '你是专业的中文写作者。根据主题输出 JSON，结构：' +
            '{"title":"标题","subtitle":"副标题","sections":[{"heading":"小节标题","paragraphs":["段落1","段落2"],"bullets":["可选要点"]}]}。' +
            `要求：${sections} 个小节；每节 1~2 段，每段 90~180 个汉字；语言简体中文；不要 Markdown；不要输出 JSON 以外的任何文字。`,
        },
        { role: 'user', content: `主题：${topic}` },
      ],
      model: this.cfg.model || 'deepseek-flash',
      maxTokens: 6000,
      temperature: 0.7,
    });
    const obj = parseJson(res.content);
    return {
      title: String(obj.title || topic).slice(0, 60),
      subtitle: String(obj.subtitle || '').slice(0, 80),
      sections: (obj.sections || []).slice(0, sections),
    };
  }

  async #build(spec) {
    const stamp = `${Date.now()}`;
    const ext = spec.kind === 'docx' ? 'docx' : 'pptx';
    const file = path.join(DOCS_DIR, `${spec.kind}-${stamp}.${ext}`);
    const specPath = path.join(DOCS_DIR, `${spec.kind}-${stamp}.json`);
    fs.writeFileSync(specPath, JSON.stringify({ ...spec, out: file }, null, 2), 'utf8');
    try {
      await execFileAsync(this.#python(), [path.join(ROOT, 'scripts', 'build_office.py'), specPath], {
        timeout: 180000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
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

  /** 生成 PPT，返回 { file, name, title, pages }。 */
  async makePpt({ topic, pages = 12, theme = 'history', withImages = true } = {}) {
    const started = Date.now();
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

      const textLen = (i) => (outline.slides[i].bullets || []).join('').length;
      // 优先跳过“本身已有视觉元素”的页（卡片/图表），其次跳过文字最多的页
      const skippable = contentIdx.filter((i) => !outline.slides[i].cards && !outline.slides[i].chart);
      const skip = [];
      const pool1 = [...skippable].sort((a, b) => textLen(b) - textLen(a));
      if (pool1.length) skip.push(pool1[0]);
      const pool2 = skippable.filter((i) => !skip.includes(i)).sort((a, b) => textLen(b) - textLen(a));
      if (pool2.length && contentIdx.length - maxImages >= 2) skip.push(pool2[0]);

      const picks = contentIdx.filter((i) => !skip.includes(i)).slice(0, maxImages);
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
      slides: outline.slides,
    });
    const name = `${outline.title}-${outline.slides.length + 2}页.pptx`.replace(/[\\/:*?"<>|]/g, '_');
    this.logger.info(`PPT 完成：${name}，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, title: outline.title, pages: outline.slides.length + 2 };
  }

  /** 生成 Excel 表格，返回 { file, name, title, rows }。 */
  async makeExcel({ topic, rows = 10, columns = 5, dataPolicy = 'example' } = {}) {
    const started = Date.now();
    const res = await this.llm.chat({
      messages: [
        {
          role: 'system',
          content:
            '你是数据整理助手。根据主题生成一张表格的 JSON：' +
            '{"title":"表格标题","sheets":[{"name":"工作表名","columns":["列1","列2"],"rows":[["值1","值2"]]}]}。' +
            `要求：1 个工作表，${columns} 列左右、${rows} 行左右；列名简洁；` +
            (dataPolicy === 'provided' ? '仅整理提供的原始数据，不填造数值、不生成示例数据；缺失值留空，不因行数要求补造记录。' : '允许示例数据，标题必须注明“示例”，不能冒充真实统计。') +
            '数字用数字类型，日期写成 2026-10-24 这种字符串；语言简体中文；不要 Markdown；不要输出 JSON 以外的任何文字。',
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
      theme: 'business',
      title: String(obj.title || topic).slice(0, 60),
      sheets,
    });
    const name = `${String(obj.title || topic).slice(0, 40)}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
    this.logger.info(`Excel 完成：${name}，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, title: String(obj.title || topic), rows: sheets[0].rows.length };
  }

  /** 生成 Word，返回 { file, name, title, sections }。 */
  async makeDocx({ topic, sections = 5 } = {}) {
    const started = Date.now();
    const outline = await this.#outlineDocx({ topic, sections });
    const file = await this.#build({
      kind: 'docx',
      theme: 'business',
      title: outline.title,
      subtitle: outline.subtitle,
      sections: outline.sections,
    });
    const name = `${outline.title}.docx`.replace(/[\\/:*?"<>|]/g, '_');
    this.logger.info(`Word 完成：${name}，用时 ${Math.round((Date.now() - started) / 1000)}s`);
    return { file, name, title: outline.title, sections: outline.sections.length };
  }
}
