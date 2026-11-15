import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-generation-'));
const previous = process.env.QQBOT_DATA;
process.env.QQBOT_DATA = dir;
const { Office } = await import('../src/office.js');
after(() => { if (previous === undefined) delete process.env.QQBOT_DATA; else process.env.QQBOT_DATA = previous; fs.rmSync(dir, { recursive: true, force: true }); });
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/office-plans.json', import.meta.url)));
const logger = { info() {}, warn() {} };
const python = process.env.OFFICE_TEST_PYTHON || 'python3';
function available(t) {
  const r = spawnSync(python, ['-c', 'import pptx, docx, openpyxl']);
  if (r.status && !process.env.OFFICE_TEST_PYTHON) { t.skip('Python Office libraries unavailable'); return false; }
  assert.equal(r.status, 0); return true;
}
test('Excel repairs division by zero, uses main model and delivers .xlsx with correct cached totals', async t => {
  if (!available(t)) return;
  const requests = [], initial = structuredClone(fixture.workbook);
  initial.sheets[0].computedColumns[0].formula = '={B}/0';
  const office = new Office({ cfg: {}, logger, pythonPath: python, llm: { cfg: { model: 'main-model' }, chat: async request => {
    requests.push(structuredClone(request));
    return { content: JSON.stringify(requests.length === 1 ? initial : fixture.workbook) };
  } } });
  const result = await office.makeExcel({ topic: '采购预算', sourceText: fixture.source });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'main-model');
  assert.ok(requests[1].messages.at(-1).content.includes('公式校验失败'));
  assert.equal(path.extname(result.file), '.xlsx');
  const read = spawnSync(python, ['-c', 'from openpyxl import load_workbook; import sys; w=load_workbook(sys.argv[1],data_only=True); print(w.active["D6"].value)', result.file], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(Number(read.stdout), 500);
  assert.equal(fs.readdirSync(path.dirname(result.file)).length, 1, 'failed builds and JSON specs are removed');
});
test('PPT creates exact requested total pages in one plan and honors zero image budget', async t => {
  if (!available(t)) return;
  let calls = 0;
  const office = new Office({ cfg: { imagesPerDeck: 0 }, logger, pythonPath: python,
    llm: { chat: async () => { calls++; return { content: JSON.stringify(fixture.deck) }; } },
    imageGen: { generate: async () => assert.fail('zero image budget must not generate paid images') } });
  const result = await office.makePpt({ topic: fixture.deck.title, sourceText: fixture.source, totalPages: 9 });
  assert.equal(result.pages, 9); assert.equal(calls, 1);
  const read = spawnSync(python, ['-c', 'from pptx import Presentation; import sys; print(len(Presentation(sys.argv[1]).slides))', result.file], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr); assert.equal(Number(read.stdout), 9);
});

test('blank templates honor explicit no-formula requests', async t => {
  if (!available(t)) return;
  let calls = 0;
  const plan = { title: '任务模板', sheets: [{ name: '任务', dataMode: 'template',
    columns: ['任务', '负责人', '截止日期'], rows: [[null, null, null], [null, null, null]] }] };
  const office = new Office({cfg: {},logger,pythonPath: python,llm: {chat: async () => {
    calls++; return {content: JSON.stringify(plan)};
  }}});
  const result = await office.makeExcel({topic: '任务模板',sourceText: '制作空白任务模板，不需要公式，也不要填虚构数据。'});
  assert.equal(calls, 1); assert.ok(fs.existsSync(result.file));
});
