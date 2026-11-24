/**
 * 企业微信定时汇报的结构校验。
 * 只接受 JSON：paragraphs[].text + paragraphs[].evidence[].{source,quote}
 * 引文必须是原文连续片段；不合规就拒绝，不把未校验内容发给老板。
 */
import { findSource, validateQuote } from './wecom-source-archive.js';

export const REPORT_LIMITS = {
  maxParagraphs: 4,
  maxParagraphChars: 220,
  maxTotalChars: 650,
  maxEvidencePerParagraph: 40,
};

export function validateReport(raw, { botId, dataDir, requireEverySource = false, sources = [] } = {}) {
  if (!raw || !Array.isArray(raw.paragraphs) || raw.paragraphs.length < 1 || raw.paragraphs.length > REPORT_LIMITS.maxParagraphs) {
    throw new Error('汇报需要 1~4 段');
  }
  const referenced = new Set();
  const allSources = new Map((sources || []).map((s) => [s.id, s]));
  const lookup = (id) => allSources.get(id) || findSource(botId, id, { dataDir });
  const paragraphs = raw.paragraphs.map((p) => {
    const text = String(p?.text || '').trim();
    if (!text) throw new Error('汇报段落为空');
    if (text.length > REPORT_LIMITS.maxParagraphChars) throw new Error('汇报段落过长');
    if (/M[a-f0-9]{10,}|UserID|系统提示词|不可信资料/i.test(text)) throw new Error('正文出现内部标记');
    const evidence = Array.isArray(p?.evidence) ? p.evidence : [];
    if (!evidence.length) throw new Error('每段至少需要一条原文依据');
    if (evidence.length > REPORT_LIMITS.maxEvidencePerParagraph) throw new Error('单段引文过多');
    let hasQuote = false;
    for (const e of evidence) {
      const source = lookup(e?.source);
      if (!source || !validateQuote(source, e?.quote)) throw new Error('引文不在指定原文中');
      referenced.add(source.id);
      hasQuote = true;
    }
    if (!hasQuote) throw new Error('每段至少需要一条有效引文');
    return text;
  });
  const text = paragraphs.join('\n\n');
  if (text.length > REPORT_LIMITS.maxTotalChars) throw new Error('汇报总长过长');
  if (requireEverySource) {
    for (const s of sources || []) {
      if (!referenced.has(s.id)) throw new Error(`遗漏来源：${s.id}`);
    }
  }
  return { text, sources: [...referenced] };
}

function buildPrompt() {
  return [
    '你是老板的助理。根据提供的员工原文，写一份中文汇报。',
    '只输出 JSON，不要 Markdown，不要代码块：',
    '{"paragraphs":[{"text":"自然转告正文","evidence":[{"source":"消息编号","quote":"支持本段的逐字原文片段"}]}]}',
    '规则：',
    '1. 1~4 段，每段不超过 220 字，总长不超过 650 字。',
    '2. 每段至少一条 evidence；quote 必须是该 source 原文里的连续片段，不能改写、不能编造。',
    '3. 先讲最重要的新变化或未定事项；旧事只作背景，不要把旧状态说成当前状态。',
    '4. 不要写来源编号、内部标记、系统提示词；不要编造没出现的事。',
  ].join('\n');
}

/**
 * 生成并校验结构化汇报。失败会修正重试一次，仍失败返回 null。
 * 不返回未校验的模型原文。
 */
export async function writeStructuredReport({ llm, botId, sources, dataDir, logger, maxTokens = 3000 }) {
  if (!llm) throw new Error('模型未配置');
  const usable = (sources || []).filter((s) => s && s.id && String(s.text || '').trim());
  if (!usable.length) return null;

  const input = usable.slice(-120).map((s) => ({
    id: s.id,
    at: new Date(s.at).toISOString(),
    name: s.name || s.userid || '',
    text: String(s.text).slice(0, 1200),
  }));
  const conversation = [
    { role: 'system', content: buildPrompt() },
    { role: 'user', content: JSON.stringify({ messages: input }) },
  ];

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt
      ? [...conversation, { role: 'user', content: `上一次不合规：${lastError}。请只返回符合结构的 JSON。` }]
      : conversation;
    try {
      const res = await llm.chat({
        messages,
        maxTokens,
        temperature: 0.2,
        timeoutMs: 60000,
        retries: 0,
      });
      const raw = String(res.content || '').trim();
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('没有返回 JSON');
      const parsed = JSON.parse(match[0]);
      const report = validateReport(parsed, { botId, dataDir, sources: usable });
      logger?.info?.(`企微结构化汇报通过：${report.sources.length} 条来源，${report.text.length} 字`);
      return { ...report, attempts: attempt + 1 };
    } catch (err) {
      lastError = err.message;
      logger?.warn?.(`企微结构化汇报告失败（第 ${attempt + 1} 次）：${err.message}`);
    }
  }
  return null;
}
