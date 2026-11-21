import assert from 'node:assert/strict';
import { cleanRelayContent, parseRelayCommand, parseRelayToCommand, parseGroupCommand } from '../src/wecom-relay.js';
import { parseGroupAssignment } from '../src/wecom-groups.js';

const now = new Date('2026-11-20T11:13:00+08:00');
const known = ['张三', '李四', '王五', '老板'];

function cmd(text, isBoss = true) {
  return parseRelayCommand(text, { isBoss, known, now });
}

// 口头前缀 / 标点
assert.equal(cleanRelayContent('一下，干得不错'), '干得不错');
assert.equal(cleanRelayContent('说，干得不错'), '干得不错');
assert.equal(cleanRelayContent('说一下，干得不错'), '干得不错');
assert.equal(cleanRelayContent('帮我跟张三说一下，干得不错'), '跟张三说一下，干得不错');

// 核心回归：不能把“一下”带进正文
assert.equal(cmd('跟张三说一下，干得不错').content, '干得不错');
assert.equal(cmd('帮我跟张三说一声，干得不错').content, '干得不错');
assert.equal(cmd('告诉张三一下，辛苦了').content, '辛苦了');
assert.equal(cmd('告诉张三，方案通过了').content, '方案通过了');
assert.equal(cmd('跟张三说，明天开会').content, '明天开会');
assert.equal(cmd('发给张三，明天开会').content, '明天开会');

// 多收件人
const multi = cmd('发给张三和李四，明天开会');
assert.deepEqual(multi.names, ['张三', '李四']);
assert.equal(multi.content, '明天开会');

const multi2 = cmd('告诉张三和李四，明天十点开会');
assert.deepEqual(multi2.names, ['张三', '李四']);
assert.equal(multi2.content, '明天十点开会');
assert.equal(multi2.isSchedule, false);

const multi3 = cmd('发给张三、李四、王五，下午三点');
assert.equal(multi3.names.length, 3);
assert.equal(multi3.content, '下午三点');
assert.equal(multi3.isSchedule, false);

// 定时
const timed = cmd('明天下午三点提醒张三和李四交周报');
assert.equal(timed.isSchedule, true);
assert.equal(timed.content, '交周报');
assert.equal(new Date(timed.when.at).getHours(), 15);

// 只是正文里提到“明天”，不能误判成定时
const notTimed = cmd('告诉张三明天开会');
assert.equal(notTimed.isSchedule, false);
assert.equal(notTimed.content, '明天开会');

// 取消 / 查询
assert.equal(cmd('取消定时').action, 'cancel');
assert.equal(cmd('我有哪些待发').action, 'list');

// 组指令
const g = (text) => parseGroupCommand(text, { groupNames: ['宣传组', '技术组'], now });
assert.equal(g('给宣传组发个消息：明天十点开会').content, '明天十点开会');
assert.equal(g('给宣传组发个消息：明天十点开会').isSchedule, false);
assert.equal(g('宣传组：明天十点开会').content, '明天十点开会');
assert.equal(g('明天下午三点给宣传组发个消息').isSchedule, true);
assert.equal(g('通知宣传组明天十点开会').isSchedule, true);
assert.equal(g('通知宣传组明天十点开会').content, '开会');
assert.equal(g('给宣传组的所有员工发个消息，今晚加工资').content, '今晚加工资');

// “给X传话/带话”
assert.deepEqual(parseRelayToCommand('帮我给老传话说一下，他很帅').names, ['示例员工B']);
assert.equal(parseRelayToCommand('帮我给老传话说一下，他很帅').content, '他很帅');
assert.equal(parseRelayToCommand('给老带句话，辛苦了').content, '辛苦了');
assert.equal(parseRelayToCommand('明天下午三点给老传话：开会').isSchedule, true);
assert.equal(parseRelayToCommand('给老发个消息：你好').content, '你好');
assert.equal(parseRelayToCommand('下午两点给示例员工A发消息：你好').isSchedule, true);
assert.equal(parseRelayToCommand('下午两点给示例员工A发消息：你好').content, '你好');
assert.equal(parseRelayToCommand('给宣传组发个消息：明天开会'), null);

// 组归属
assert.deepEqual(parseGroupAssignment('我是宣传组的', { isBoss: false }), {
  action: 'add', group: '宣传组', names: [], self: true,
});
assert.deepEqual(parseGroupAssignment('把张三和李四加到宣传组', { isBoss: true }).names, ['张三', '李四']);
assert.deepEqual(parseGroupAssignment('张三在宣传组', { isBoss: true }).group, '宣传组');
assert.equal(parseGroupAssignment('把张三从宣传组移出', { isBoss: true }).action, 'remove');
assert.equal(parseGroupAssignment('给宣传组发个消息：明天开会', { isBoss: true }), null);

console.log('relay parser tests passed');
