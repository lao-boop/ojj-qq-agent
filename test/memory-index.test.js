import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, vectorScores } from '../src/memory-index.js';

test('new conversations have no older messages to score', () => {
  const index = buildIndex([]);
  assert.equal(index.n, 0);
  for (const query of ['你好', 'hello', '']) {
    assert.deepEqual(vectorScores(index, query), []);
  }
});

test('conversations with only recent messages have an empty retrieval index', () => {
  const turns = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }];
  const recent = turns.slice(-60);
  const older = turns.slice(0, turns.length - recent.length);
  assert.deepEqual(vectorScores(buildIndex(older), '之前说了什么'), []);
});

test('nonempty retrieval still scores every document and ranks relevant text first', () => {
  const index = buildIndex([{ content: '企业微信机器人配置' }, { content: '今天中午吃米饭' }]);
  const scores = vectorScores(index, '企业微信机器人');
  assert.equal(scores.length, 2);
  assert.ok(scores.every(Number.isFinite));
  assert.ok(scores[0] > scores[1]);
});
