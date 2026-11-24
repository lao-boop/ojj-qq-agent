import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveSource,
  listSources,
  sourceId,
  validateQuote,
  validateEvidence,
  wecomScope,
  wecomDataDir,
} from '../src/wecom-source-archive.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-source-'));
}

test('来源编号稳定，且 quote 必须是原文连续片段', () => {
  const dataDir = tempDir();
  const at = 1795000000000;
  const rec = archiveSource({
    botId: 'bot-a',
    userid: 'u1',
    name: '员工甲',
    chattype: 'single',
    text: '模拟评审001改到2026-10-15，原因是样本没备齐。',
    at,
    dataDir,
  });
  assert.ok(rec.id.startsWith('M'));
  assert.equal(rec.id, sourceId({ at, userid: 'u1', text: rec.text }));
  assert.equal(listSources('bot-a', { dataDir }).length, 1);
  assert.equal(validateQuote(rec, '改到2026-10-15'), true);
  assert.equal(validateQuote(rec, '改到2026-10-16'), false);
  const ok = validateEvidence('bot-a', [{ source: rec.id, quote: '样本没备齐' }], { dataDir });
  assert.equal(ok.ok, true);
  const bad = validateEvidence('bot-a', [{ source: rec.id, quote: '样本已经备齐' }], { dataDir });
  assert.equal(bad.ok, false);
});

test('不同 Bot ID 使用不同数据目录，互不可见', () => {
  const dataDir = tempDir();
  archiveSource({ botId: 'bot-a', userid: 'u1', text: 'A 的消息', at: 1, dataDir });
  archiveSource({ botId: 'bot-b', userid: 'u2', text: 'B 的消息', at: 2, dataDir });
  assert.equal(listSources('bot-a', { dataDir }).length, 1);
  assert.equal(listSources('bot-b', { dataDir }).length, 1);
  assert.notEqual(wecomScope('bot-a'), wecomScope('bot-b'));
  assert.notEqual(wecomDataDir('bot-a', dataDir), wecomDataDir('bot-b', dataDir));
});
