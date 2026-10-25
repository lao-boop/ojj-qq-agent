import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LLM } from '../src/llm.js';
import { Logger } from '../src/logger.js';
import { loadConfig, DATA_DIR } from '../src/config.js';
import { Aligner } from '../src/asr.js';
import { ffmpegBin } from '../src/media.js';

const execFileAsync = promisify(execFile);
const DATA_ROOT = process.env.AUTOREPAIR_DIR || 'C:\\Users\\user\\Desktop\\auto_repair_multimodal_v1';
const OUT_DIR = path.join(DATA_DIR, 'auto_repair');
const CACHE_DIR = path.join(OUT_DIR, 'cache');
const PYTHON = process.env.PYTHON_PATH || 'C:\\Users\\user\\AppData\\Local\\AstrBot\\backend\\python\\python.exe';

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const logger = new Logger({ level: 'info', file: false, name: 'autorepair' });
const cfg = loadConfig();
const llm = new LLM(cfg.llm, logger.child('llm'));
const visionModel = 'deepseek-flash';
const aligner = new Aligner({ enabled: true, token: cfg.song.token, model: 'victor-upmeet/whisperx' }, logger.child('asr'));

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((s) => s.trim())
    .map((s) => JSON.parse(s));
}

function hashFile(file) {
  const stat = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 16);
}

function extractJson(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) throw new Error('没有 JSON');
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('JSON 不完整');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 大图先压到 1280px 再送视觉，省时间省 token */
async function shrinkImage(file) {
  const stat = fs.statSync(file);
  if (stat.size < 400 * 1024) return file;
  const out = path.join(CACHE_DIR, `small-${hashFile(file)}.jpg`);
  if (fs.existsSync(out)) return out;
  await execFileAsync(
    ffmpegBin(),
    ['-y', '-loglevel', 'error', '-i', file, '-vf', 'scale=1280:-2:flags=lanczos', '-q:v', '3', out],
    { timeout: 60000, windowsHide: true },
  );
  return out;
}

/** 图片 → 文字（按附件用途给不同指令），带缓存 */
async function captionImage(file) {
  const cache = path.join(CACHE_DIR, `vision-v3-${hashFile(file)}.json`);
  if (fs.existsSync(cache)) {
    try {
      return JSON.parse(fs.readFileSync(cache, 'utf8')).text;
    } catch {
      /* 重新识别 */
    }
  }
  const small = await shrinkImage(file);
  const buf = fs.readFileSync(small);
  const ext = path.extname(small).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const prompt =
    '这是一张汽修群里的图片，可能是配件照片、车辆照片、维修单、VIN 采集卡或聊天截图。请：\n' +
    '1) 若是配件：描述可见外观特征、形状、颜色、安装位置线索；不要猜品牌、型号、OE 号。\n' +
    '   若是车辆：说明车身形式（轿车/SUV）和颜色，并**明确回答车身/保险杠上有没有划痕、擦伤、剐蹭、掉漆或凹陷**（有就指出位置，没有就说没有）。\n' +
    '2) 若是单据/VIN/聊天截图：逐字转写可见文字与数字，保留行结构和字段名；看不清的字符用 ?，不要补字。\n' +
    '   若是 VIN：把 17 位逐位读出来（可以写成 Z Z Z T E S T ... 的间隔形式），被遮挡的每一位写 ?；' +
    '   字母 O 与数字 0 严格区分，原样抄录，不要互相替换、不要规范化。\n' +
    '3) 明确说明图片里有没有文字、有没有遮挡。\n' +
    '用中文输出，不要客套，不要编造图外的信息。';
  const res = await llm.chat({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    model: visionModel,
    maxTokens: 1500,
    temperature: 0.1,
  });
  let text = String(res.content || '').trim();
  if (!text && res.message?.reasoning_content) text = String(res.message.reasoning_content).slice(-500).trim();
  fs.writeFileSync(cache, JSON.stringify({ file, text }, null, 2));
  return text;
}

/** 音频 → 转写（Replicate WhisperX，带缓存） */
const asrCache = new Map();
async function transcribeAudio(file) {
  if (!asrCache.size) {
    const cachePath = path.join(CACHE_DIR, 'asr-extra.json');
    if (fs.existsSync(cachePath)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cachePath, 'utf8')))) asrCache.set(k, v);
      } catch {
        /* ignore */
      }
    }
  }
  const key = hashFile(file);
  if (asrCache.has(key)) return asrCache.get(key);
  const words = await aligner.wordsFor(file);
  const text = words.map((w) => w.word).join('');
  asrCache.set(key, text);
  fs.writeFileSync(path.join(CACHE_DIR, 'asr-extra.json'), JSON.stringify(Object.fromEntries(asrCache), null, 2));
  return text;
}

/** 24 类配件库压成提示词里的一段 */
function buildCatalog() {
  const rows = readJsonl(path.join(DATA_ROOT, 'agent', 'knowledge', 'parts_catalog.jsonl'));
  return rows
    .map(
      (r) =>
        `${r.part_id} ${r.name_zh}(${r.aliases.join('/')})｜特征:${r.visual_cues}｜易混:${(r.confusable_part_ids || []).join(',')}｜注意:${r.clarification_note}`,
    )
    .join('\n');
}

function buildSystem() {
  const base = fs.readFileSync(path.join(DATA_ROOT, 'agent', 'agent_prompt.txt'), 'utf8');
  return (
    base.trim() +
    '\n\n【配件分类库】\n' +
    buildCatalog() +
    '\n\n【输出】只输出一个 JSON 对象：{"case_id":"案例ID","result":{...}}，不要 markdown、不要解释。' +
    'result 里只放本次任务需要的字段；没有把握的字段用 null 或空数组，不要编造。\n\n' +
    '【必须遵守的字段规则】\n' +
    '0) 每条 result 都必须包含 part_ids / needs_clarification / fitment_confirmed / oe_number / action / reply / evidence / order_authorized / excluded_part_ids / cancelled_part_ids；' +
    'order_authorized 默认 false，只有对方明确说「就这个/下单/买了/按这个来」才 true；excluded_part_ids 和 cancelled_part_ids 默认空数组。其余字段按任务补。\n' +
    '1) 字段要完整：vehicle 必须给全 body_type/make/model/year/color/visible_scuff（未知 null；visible_scuff 必须是布尔，没看到划痕就 false）；' +
    'vin 必须给全 visible_text/complete/format_valid/authoritative_decoded/conflict；' +
    'document 必须给全 number/printed_total/computed_total/amount_mismatch/currency；' +
    'items 每项必须含 part_id/quantity/unit/position（没有位置用 null）。\n' +
    '2) VIN 逐字抄录：字母 O 和数字 0 严格区分，不要把 O 改成 0、也不要把 0 改成 O；' +
    '看不清的字符用 ? 保留位置；不要自动补字或纠错；format_valid 只有在 17 位且字符都属于允许集合（不含 I/O/Q）时才为 true；' +
    '只有部分可见时 complete=false、format_valid=null，visible_text 仍要写「可见字符 + 每个遮挡位一个 ?」；' +
    '如果出现两个不同的完整 VIN，visible_text=null、candidates=[两个 VIN]、conflict=true、complete=true、format_valid=true（两个都合法时）。\n' +
    '3) 单据：computed_total 用所有明细行（含工时）重新核算，与 printed_total 比较，不等则 amount_mismatch=true；' +
    'printed_total 或 computed_total 任一为 null 时 amount_mismatch=false；' +
    '缺单价或数量时 computed_total=null，不要编造合计；printed_total 只抄原单，读不到就 null；items 列表本身不含工时；' +
    '单据任务只输出 document/items，不要输出 vin。\n' +
    '4) 车辆：不要从外观猜品牌/车型/年款，未知一律 null；能从照片确认的只有车身形式、颜色、可见外观；' +
    '图片描述里出现划痕/擦伤/剐蹭/掉漆/凹陷 → visible_scuff=true；描述明确说没有划痕 → false。\n' +
    '5) 配件：只能从分类库里选 part_id；不确定就给空数组并追问。外观能确认类别 ≠ 能确认 OE 号/型号/适配。' +
    '图片被遮挡/看不清、无法确认类别时 part_ids=[]、needs_clarification=true、action=clarify。\n' +
    '6) needs_clarification 判定：只是问「这是什么/能确认吗/帮我看看」→ false；' +
    '一旦涉及配货、适配、报价、下单，但缺车辆信息/位置/数量/标号 → true；对方明说「资料等会儿发/稍后补」→ true；' +
    '图片遮挡无法识别 → true。\n' +
    '7) fitment_confirmed 默认 false；没有 OE 号 + 车型/年款适配依据时一律 false，不能因为外观像就 true。\n' +
    '8) 跨附件：先各自识别再核对关系；照片与单据类别不符、或无法证明同一车/同一单时 media_conflict=true、needs_clarification=true，不要强行关联。' +
    '跨附件时 part_ids 只写照片/询价里明确涉及的类别，单据明细放 items，不要把单据里的配件混进 part_ids。\n' +
    '9) 单据金额不一致（amount_mismatch=true）、或数量/单价缺失时，needs_clarification=true、action=clarify。\n' +
    '10) 聊天截图：customer 是「发起需求的人名」字符串（不是对象，也不是 transcript）；' +
    '同一客户后来的更正覆盖旧需求，被取消的写 cancelled_part_ids，明确「不要/先别要」的写 excluded_part_ids；' +
    '聊天任务 action=quote_request，order_authorized 未明确下单为 false。\n' +
    '11) 语音：transcript 只放语音转写文本（不要塞聊天记录）；否定项写 excluded_part_ids；数量单位按原话保留。\n' +
    '12) 精简：reply 不超过 120 字，evidence 不超过 200 字；宁可短，也要保证 JSON 完整闭合。'
  );
}

async function runCase(c) {
  const log = (m) => fs.appendFileSync(path.join(OUT_DIR, 'progress.log'), `${new Date().toISOString()} ${m}\n`);
  const parts = [`【用户消息】${c.messages.map((m) => m.text).join('\n')}`];
  const attachments = [];
  for (const a of c.messages.flatMap((m) => m.attachments || [])) attachments.push(a);
  let idx = 0;
  for (const att of attachments) {
    const file = path.join(DATA_ROOT, att.path);
    idx++;
    if (!fs.existsSync(file)) {
      parts.push(`\n【附件${idx}】缺失：${att.path}`);
      continue;
    }
    if (/\.(png|jpe?g|webp)$/i.test(file)) {
      log(`${c.case_id} 识别图片 ${att.path}`);
      const cap = await captionImage(file);
      parts.push(`\n【附件${idx}：图片】\n${cap}`);
    } else if (/\.wav$/i.test(file)) {
      log(`${c.case_id} 转写语音 ${att.path}`);
      const text = await transcribeAudio(file);
      parts.push(`\n【附件${idx}：语音】\n${text}`);
    }
  }

  // 三次尝试：主模型 → flash → 主模型（更高额度 + 直接输出 JSON）
  const attempts = [
    { model: undefined, maxTokens: 6000, temperature: 0.1, extra: '' },
    { model: 'deepseek-flash', maxTokens: 6000, temperature: 0, extra: '\n\n只输出合法 JSON。' },
    { model: undefined, maxTokens: 8000, temperature: 0, extra: '\n\n直接输出 JSON，不要解释，不要复述题目，不要写 markdown。' },
  ];
  let parsed = null;
  let lastErr = null;
  for (const at of attempts) {
    try {
      const res = await llm.chat({
        messages: [
          { role: 'system', content: buildSystem() },
          { role: 'user', content: parts.join('\n') + at.extra },
        ],
        ...(at.model ? { model: at.model } : {}),
        maxTokens: at.maxTokens,
        temperature: at.temperature,
      });
      try {
        parsed = extractJson(res.content);
        break;
      } catch (err) {
        lastErr = err;
        fs.writeFileSync(path.join(OUT_DIR, `fail-${c.case_id}.txt`), String(res.content || ''), 'utf8');
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (!parsed) throw lastErr || new Error('没有 JSON');
  return { case_id: c.case_id, result: parsed.result ?? parsed };
}

async function main() {
  const args = process.argv.slice(2);
  const split = (args.find((a) => a.startsWith('--split=')) || '--split=dev').split('=')[1];
  const limit = Number((args.find((a) => a.startsWith('--limit=')) || '--limit=0').split('=')[1]) || 0;
  const inputsFile = path.join(DATA_ROOT, 'agent', 'inputs', `${split}_inputs.jsonl`);
  const goldFile = path.join(DATA_ROOT, 'evaluator', `${split}_gold.jsonl`);
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const onlyIds = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : [];
  let cases = readJsonl(inputsFile).slice(0, limit || undefined);
  if (onlyIds.length) cases = cases.filter((c) => onlyIds.includes(c.case_id));
  const predFile = path.join(OUT_DIR, `${split}-predictions.jsonl`);
  const reportFile = path.join(OUT_DIR, `${split}-report.json`);

  logger.info(`开始评测 ${split}：${cases.length} 个案例`);
  const out = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    try {
      const pred = await runCase(c);
      out.push(pred);
      logger.info(`[${i + 1}/${cases.length}] ${c.case_id} ok`);
    } catch (err) {
      logger.warn(`[${i + 1}/${cases.length}] ${c.case_id} 失败：${err.message}`);
      out.push({ case_id: c.case_id, result: {} });
    }
    await sleep(300);
  }
  let finalOut = out;
  if (onlyIds.length) {
    // 只重跑部分案例：与已有预测合并，按 gold 顺序写回
    const existing = fs.existsSync(predFile) ? readJsonl(predFile) : [];
    const map = new Map(existing.map((p) => [p.case_id, p]));
    for (const p of out) map.set(p.case_id, p);
    finalOut = readJsonl(goldFile)
      .map((g) => map.get(g.case_id))
      .filter(Boolean);
  }
  fs.writeFileSync(predFile, finalOut.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');

  const { stdout } = await execFileAsync(
    PYTHON,
    [path.join(DATA_ROOT, 'tools', 'evaluate.py'), '--gold', goldFile, '--predictions', predFile, '--out', reportFile],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  console.log(stdout);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  console.log(
    `\n结果：${split} 案例通过率 ${(report.structural_case_pass_rate * 100).toFixed(1)}% / 字段通过率 ${(report.structural_check_pass_rate * 100).toFixed(1)}%`,
  );
  console.log('按任务：', JSON.stringify(report.by_task));
  if (report.asr) console.log('ASR CER:', report.asr.cer);
}

main().catch((e) => {
  console.error('评测失败：', e);
  process.exit(1);
});

