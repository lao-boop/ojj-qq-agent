import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceClarifications, conversationalFields, shiftDeferredFields } from '../src/voice-clarification.js';

test('叙述句只追问关键分歧，不打断明确的指代和语气',()=>{
  const field=(text,opts)=>({label:'用词',start:text.indexOf(opts[0]),end:text.indexOf(opts[0])+opts[0].length,options:opts});
  const text='发言人名叫李琳，会议不能提前';
  const who=field(text,['李琳','李林']), when=field(text,['不能','能']);
  assert.deepEqual(conversationalFields(text,[who,when]),[when]);
  assert.deepEqual(conversationalFields(text,[who]),[who]);
  for(const [s,options] of [['他马上到',['他','她']],['已经走得快了',['走得快','走的快']],['提醒我一下呀',['一下呀','一下啊']]]) {
    assert.deepEqual(conversationalFields(s,[field(s,options)]),[]);
  }
  const story='他说要付款。今天遇到罕见的字';
  assert.deepEqual(conversationalFields(story,[field(story,['罕见','喊见','含建'])]),[]);
});

test('用户补全早先的名称后，后面待校对的词仍能对齐',()=>{
  const word={start:5,end:7,options:['蓝图','兰图']};
  shiftDeferredFields([word],{start:0,end:2},'欧阳林');
  assert.equal(word.start,6);
  assert.equal(word.end,8);
});

const name = { start: 2, end: 4, label: '名字', options: ['佟健', '董建'] };
const count = { start: 5, end: 8, label: '数量', options: ['十三箱', '三十箱'] };
const text = '发给佟健的十三箱配件';

test('接受对局部用词的文字纠正，不把无关发言带入原句', async () => {
  const session = new VoiceClarifications();
  const q = {start: 2, end: 6, label: '用词', options: ['靠窗座位', '靠边座位']};
  const pending = session.confirm('群/张', '预留靠窗座位两张', [q], prompt => {
    assert.match(prompt,/“靠窗座位”还是“靠边座位”/);
  });
  assert.equal(session.answer('群/张','好的'), false);
  assert.equal(session.answer('群/张','第二节会议取消'), false);
  assert.equal(session.answer('群/张','用词是过道座位'), true);
  assert.equal(await pending,'预留过道座位两张');
});

test('逐处追问，同一群仅原发言人能补全原句', async () => {
  const session = new VoiceClarifications();
  const questions = [];
  const pending = session.confirm('group1/张', text, [name, count], q => questions.push(q));
  assert.equal(questions.length, 1);
  assert.equal(session.answer('group1/李', '第二个'), false);
  assert.equal(session.answer('private/张', '第二个'), false);
  assert.equal(session.answer('group1/张', '是的'), false);
  assert.equal(session.answer('group1/张', '名字是童建'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(questions, ['名字我没听准，是“佟健”还是“董建”？', '数量我没听准，是“十三箱”还是“三十箱”？']);
  assert.equal(session.answer('group1/张', '后一个。'), true);
  assert.equal(await pending, '发给童建的三十箱配件');
  assert.equal(session.pending.size, 0);
});

test('补充数值、取消与替换待确认的问题', async () => {
  const session = new VoiceClarifications();
  const ask = () => session.confirm('private/张', text, [count], () => {});
  const first = ask();
  const second = ask();
  assert.equal(await first, null);
  assert.equal(session.answer('private/张', '31'), true);
  assert.equal(await second, '发给佟健的31箱配件');
  const third = ask();
  assert.equal(session.answer('private/张', '取消'), true);
  assert.equal(await third, null);
  await assert.rejects(session.confirm('private/张', text, [count], () => { throw Error('offline'); }));
  assert.equal(session.pending.size, 0);
});
