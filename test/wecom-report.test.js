import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, REPORT_LIMITS } from '../src/wecom-report.js';

const sources = [
  { id: 'M1', at: 1, userid: 'u1', name: '甲', text: '模拟评审001改到2026-10-15，原因是样本没备齐。' },
  { id: 'M2', at: 2, userid: 'u2', name: '乙', text: '小林那天缺席。' },
];

test('结构正确、引文逐字匹配时通过', () => {
  const r = validateReport(
    {
      paragraphs: [
        {
          text: '模拟评审001改到 10 月 15 日，原因是样本没备齐。',
          evidence: [{ source: 'M1', quote: '改到2026-10-15，原因是样本没备齐' }],
        },
      ],
    },
    { botId: 'test', sources },
  );
  assert.match(r.text, /10 月 15 日/);
  assert.deepEqual(r.sources, ['M1']);
});

test('引文不是原文连续片段时拒绝', () => {
  assert.throws(
    () =>
      validateReport(
        {
          paragraphs: [
            {
              text: '模拟评审001改到 10 月 15 日。',
              evidence: [{ source: 'M1', quote: '样本已经备齐' }],
            },
          ],
        },
        { botId: 'test', sources },
      ),
    /引文/,
  );
});

test('超过段数、缺依据、正文带内部编号时拒绝', () => {
  assert.throws(
    () =>
      validateReport(
        {
          paragraphs: Array.from({ length: REPORT_LIMITS.maxParagraphs + 1 }, (_, i) => ({
            text: `第${i}段`,
            evidence: [{ source: 'M1', quote: '样本没备齐' }],
          })),
        },
        { botId: 'test', sources },
      ),
    /1~4/,
  );
  assert.throws(
    () => validateReport({ paragraphs: [{ text: '没有依据' }] }, { botId: 'test', sources }),
    /依据/,
  );
  assert.throws(
    () =>
      validateReport(
        {
          paragraphs: [
            { text: 'M1234567890 说改期', evidence: [{ source: 'M1', quote: '样本没备齐' }] },
          ],
        },
        { botId: 'test', sources },
      ),
    /内部标记/,
  );
});
