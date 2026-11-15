import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateDeck, validateWorkbook, validateFormula } from '../src/office-plan.js';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/office-plans.json', import.meta.url)));
const fresh = () => structuredClone(fixture);
test('complete presentation keeps all seven layouts and precise chart provenance', () => {
  const { deck, source } = fresh();
  const result = validateDeck(deck, { count: 7, source });
  assert.equal(new Set(result.slides.map(s => s.layout)).size, 7);
  assert.deepEqual(result.slides[4].chart.series[0].values, [120, 60, 80]);
  assert.ok(source.includes(result.slides[4].source));
});
test('presentation rejects incomplete outlines, duplicates, dense content and fabricated chart values', () => {
  for (const mutate of [
    d => d.slides.pop(), d => { d.slides[1].title = d.slides[0].title; },
    d => { d.slides[0].cards[0].text = '长'.repeat(200); },
    d => { d.slides[4].chart.series[0].values.pop(); },
    d => { d.slides[4].chart.series[0].values[0] = 999; },
    d => { d.slides[4].chart.source = '虚构数据'; },
  ]) { const { deck, source } = fresh(); mutate(deck); assert.throws(() => validateDeck(deck, { count: 7, source })); }
});
test('budget preserves three actual items, generates formulas and does not add freight or sum unit prices', () => {
  const { workbook, source } = fresh();
  const result = validateWorkbook(workbook, { source, requireFormula: true });
  const sh = result.sheets[0];
  assert.deepEqual(sh.rows.map(r => r[0]), ['键盘', '鼠标', '支架', '合计']);
  assert.deepEqual(sh.rows.map(r => r[3]), ['=B3*C3', '=B4*C4', '=B5*C5', '=SUM(D3:D5)']);
  assert.equal(sh.rows[3][2], null);
  assert.deepEqual(sh.chart.values, [4]);
});
test('workbooks reject invented constants, unsupported modes, invalid data types and unrequested examples', () => {
  for (const mutate of [
    sh => { sh.rows[0][1] = 999; }, sh => { sh.rows[0][1] = '999'; },
    sh => { sh.rowSources[0] = '不存在的材料'; }, sh => { sh.dataMode = 'example'; },
    sh => { delete sh.dataMode; }, sh => { sh.rows[0].push('超出列'); },
    sh => { sh.computedColumns[0].formula = '=B999*C999'; },
  ]) { const { workbook, source } = fresh(); mutate(workbook.sheets[0]); assert.throws(() => validateWorkbook(workbook, { source })); }
});
test('formula bounds and functions exclude external links and blank-region references', () => {
  const bounds = { width: 4, lastRow: 6 };
  for (const formula of ['=B3*C3', '=SUM(D3:D5)', '=($D$3+D4)/2']) assert.doesNotThrow(() => validateFormula(formula, bounds));
  for (const formula of ['=SUM(A1:A2)', '=E3*B3', '=SUM(D3:D100)', '=WEBSERVICE("https://example.invalid")', '=Sheet2!A3']) assert.throws(() => validateFormula(formula, bounds));
});
