import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveSource } from '../src/wecom-source-archive.js';
import { queryArchive, ARCHIVE_QUERY_MAX } from '../src/wecom-archive-query.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-query-'));
}

test('最多返回 50 条，并排除老板自己的消息', () => {
  const dataDir = tempDir();
  for (let i = 0; i < 60; i++) {
    archiveSource({
      botId: 'bot-a',
      userid: 'Lao',
      name: '老',
      chattype: 'single',
      text: `员工消息 ${i}`,
      at: 1795000000000 + i * 1000,
      dataDir,
    });
  }
  archiveSource({
    botId: 'bot-a',
    userid: 'god',
    name: '老板',
    chattype: 'single',
    text: '老板自己的消息',
    at: 1795001000000,
    dataDir,
  });
  const r = queryArchive({
    botId: 'bot-a',
    ownerUserId: 'god',
    person: '老',
    limit: 999,
    dataDir,
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, ARCHIVE_QUERY_MAX);
  assert.equal(r.limit, ARCHIVE_QUERY_MAX);
  assert.match(r.text, /上限 50/);
  assert.doesNotMatch(r.text, /老板自己的消息/);
});

test('按关键词过滤，不同 Bot 数据不串', () => {
  const dataDir = tempDir();
  const base = Date.now() - 5000;
  archiveSource({ botId: 'bot-a', userid: 'Lao', name: '老', chattype: 'single', text: '报价单和合同', at: base, dataDir });
  archiveSource({ botId: 'bot-a', userid: 'Lao', name: '老', chattype: 'single', text: '别的事', at: base + 1000, dataDir });
  archiveSource({ botId: 'bot-b', userid: 'Lao', name: '老', chattype: 'single', text: '另一个 Bot 的记录', at: base + 2000, dataDir });
  const r = queryArchive({ botId: 'bot-a', ownerUserId: 'god', person: '老', keyword: '合同', dataDir });
  assert.equal(r.count, 1);
  assert.match(r.text, /报价单和合同/);
  assert.doesNotMatch(r.text, /另一个 Bot/);
});
