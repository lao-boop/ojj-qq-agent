import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CoverDelivery } from '../src/cover-delivery.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { access: { ownerQQ: '10001' }, voice: { recipients: [{ qq: '20002', name: '阿明' }] } };
  const calls = [];
  const onebot = { sendPrivate: async (...args) => { calls.push(['voice', ...args]); return { message_id: 3 }; }, call: async (...args) => { calls.push(['file', ...args]); return {}; } };
  const service = new CoverDelivery({ cfg, onebot, file: path.join(dir, 'deliveries.json') });
  const file = path.join(dir, 'song.mp3'); fs.writeFileSync(file, 'rendered-audio');
  const request = { slots: { recipient: '阿明', delivery: 'other_chat' }, instruction: '翻唱后私发给阿明', actorId: '10001', chatKey: 'private:10001' };
  return { service, request, cfg, calls, file, onebot, dir };
}

test('dedication, guessed name, unknown recipient, group and non-owner cannot authorize delivery', t => {
  const f = setup(t);
  for (const patch of [
    { instruction: '唱给阿明听' }, { instruction: '不要私发给阿明' },
    { instruction: '翻唱后私发给小王' }, { slots: { recipient: '阿', delivery: 'other_chat' } },
    { actorId: '30003', chatKey: 'private:30003' }, { chatKey: 'group:12345' },
  ]) assert.ok(f.service.resolve({ ...f.request, ...patch }).reply);
  f.cfg.voice.recipients.push({ name: '阿明', qq: '20003' });
  assert.match(f.service.resolve(f.request).reply, /重名/);
  assert.equal(f.calls.length, 0);
});

test('authorized result goes only to exact recipient and confirmed receipt is persisted', async t => {
  const f = setup(t), { authorization } = f.service.resolve(f.request);
  const result = await f.service.send({ authorization, file: f.file, name: 'song.mp3', seconds: 10 });
  assert.equal(result.ok, true); assert.match(result.reply, /阿明/);
  assert.equal(f.calls[0][1], 20002);
  assert.equal(f.calls[0][2][0].data.file, 'base64://' + Buffer.from('rendered-audio').toString('base64'));
  const records = JSON.parse(fs.readFileSync(f.service.file));
  assert.equal(records[0].status, 'sent'); assert.equal(records[0].messageId, 3);
  await assert.rejects(f.service.send({ authorization, file: f.file, name: 'again.mp3', seconds: 10 }), /不会重复发送/);
  assert.equal(f.calls.length, 1);
});

test('long audio sends one file upload with no retry or alternate recipient', async t => {
  const f = setup(t), { authorization } = f.service.resolve(f.request);
  await f.service.send({ authorization, file: f.file, name: 'song.mp3', seconds: 90 });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], 'upload_private_file');
  assert.equal(f.calls[0][2].user_id, 20002);
});

test('next-audio can reuse a scoped authorization; another actor, target or expiration cannot', t => {
  const f = setup(t), { authorization } = f.service.resolve(f.request);
  const next = { ...f.request, instruction: '清唱内容', previous: authorization };
  assert.equal(f.service.resolve(next).authorization.id, authorization.id);
  assert.equal(f.service.resolve({ ...next, instruction: '不要私发给阿明' }).authorization, null);
  assert.equal(f.service.resolve({ ...next, slots: { delivery: 'current_chat' } }).authorization, null);
  assert.ok(f.service.resolve({ ...next, actorId: '30003', chatKey: 'private:30003' }).reply);
  authorization.at -= 31 * 60 * 1000;
  assert.ok(f.service.resolve(next).reply);
});

for (const reason of ['timeout', 'rejection', 'disk', 'revoked']) test(`delivery ${reason} never falsely reports success or retries`, async t => {
  const f = setup(t), { authorization } = f.service.resolve(f.request);
  if (reason === 'disk') f.service.save = () => { throw new Error('disk full'); };
  if (reason === 'revoked') f.cfg.voice.recipients = [];
  if (reason === 'timeout' || reason === 'rejection') f.onebot.sendPrivate = async () => { f.calls.push('attempt'); throw new Error(reason === 'timeout' ? 'timeout' : 'QQ failed (retcode=1)'); };
  await assert.rejects(f.service.send({ authorization, file: f.file, name: 'song.mp3', seconds: 10 }));
  assert.equal(f.calls.length, reason === 'disk' || reason === 'revoked' ? 0 : 1);
  if (reason === 'timeout' || reason === 'rejection') {
    const records = JSON.parse(fs.readFileSync(f.service.file));
    assert.equal(records[0].status, reason === 'timeout' ? 'unknown' : 'failed');
  }
});

test('restarting after an interrupted send marks unknown and refuses repeat', async t => {
  const f = setup(t), { authorization } = f.service.resolve(f.request);
  fs.writeFileSync(f.service.file, JSON.stringify([{ id: authorization.id, status: 'sending' }]));
  const restarted = new CoverDelivery({ cfg: f.cfg, onebot: f.onebot, file: f.service.file });
  assert.equal(restarted.records[0].status, 'unknown');
  await assert.rejects(restarted.send({ authorization, file: f.file, name: 'song.mp3', seconds: 10 }), /不会重复发送/);
  assert.equal(f.calls.length, 0);
});

test('delivery facts stay in the requesting owner chat and omit local paths', async t => {
  const f = setup(t), { authorization } = f.service.resolve(f.request);
  await f.service.send({ authorization, file: f.file, name: 'song.mp3', seconds: 10 });
  assert.equal(f.service.visible('private:10001')[0].status, 'sent');
  assert.equal('file' in f.service.visible('private:10001')[0], false);
  assert.deepEqual(f.service.visible('private:20002'), []);
  assert.deepEqual(f.service.visible('group:10001'), []);
  f.cfg.access.adminQQ = ['30003'];
  assert.deepEqual(f.service.visible('private:30003'), []);
});
