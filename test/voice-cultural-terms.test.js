import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCulturalTerms} from '../src/voice-cultural-terms.js';

test('文物名需要同一语境和对齐的读音', () => {
  const phrase='今天在江都王陵看到座银边庆铜巨兽座';
  assert.equal(applyCulturalTerms(phrase).text,phrase);
  const corrected=applyCulturalTerms(phrase,[phrase.replace('座银','措银')]);
  assert.equal(corrected.text,'今天在江都王陵看到错银编磬铜虡兽座');
  assert.ok(corrected.edits[0].source);
});
test('展厅、编号和引语依靠各自的上下文', () => {
  for(const [heard,expected] of [
    ['六艺城的玉厅再现古代驾车场景','六艺城的御厅再现古代驾车场景'],
    ['文件编号是2013规条自0055号','文件编号是2013规条字0055号'],
    ['达尔富尔局势可能因为有官方的举动而复杂化','达尔富尔局势可能因为有关方的举动而复杂化'],
  ]) assert.equal(applyCulturalTerms(heard).text,expected);
  for(const sentence of ['玉厅展示和田玉','我们参观了六艺城。玉厅展示和田玉',
    '新规条自明日起生效','达尔富尔有官方的举动，也有民间的举动',
    '大云山新展出一件鎏金石雕巨兽座']) {
    assert.equal(applyCulturalTerms(sentence).text,sentence);
  }
});
