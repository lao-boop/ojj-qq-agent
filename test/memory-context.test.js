import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('口语短问能取回更正，重复旧消息只占一个位置，按时间呈现', async () => {
  process.env.QQBOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
  const {Memory} = await import('../src/memory.js');
  const memory = new Memory({cfg:{historyTurns:2, recallLimit:3}});
  const session = memory.get('isolated');
  const old = '长柄伞放在东门。';
  const latest = '折叠伞已经送到西门。';
  const rows = [old, old, latest, ...Array(130).fill('明天早上准备开会。')];
  session.turns = rows.map((content,ts) => ({role:'user',content,ts}));
  const ctx = memory.context('isolated',{query:'伞？'});
  assert.deepEqual(ctx.recalled.map(t => t.content),[old,latest]);
  assert.equal(ctx.turns.length,2);
});
