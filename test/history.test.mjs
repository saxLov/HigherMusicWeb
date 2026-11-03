import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHistoryReporter, readHistoryBody } from '../lib/history.mjs';
const hash = 'a'.repeat(32);
const body = (n = 1) => ({ songId: '321:' + hash, hash, playbackId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` });
const session = (userid = '123') => ({ user: {}, jar: { userid, token: 'private-token' }, tracks: new Map([
  [body().songId, { id: body().songId, hash, albumAudioId: 321, checked: true,
    eligible: true, state: 'allowed', playbackState: 'allowed' }],
]) });
test('从会话登记记录取平台ID，复用当前账号；不接收客户端次数与Cookie', async () => {
  const s = session(); let actual;
  const report = createHistoryReporter(async (...args) => { actual = args; return { status: 1 }; });
  assert.deepEqual(await report(s, { ...body(), pc: 999, cookie: 'evil' }), { ok: true, accepted: true });
  assert.equal(actual[0], s); assert.equal(actual[1], 'playhistory_upload');
  assert.deepEqual(actual[2], { mxid: 321 });
});
test('账号跨会话节流与轮次去重；独立账号不互相阻塞', async () => {
  let time = 0, calls = 0;
  const report = createHistoryReporter(async () => { calls++; return { status: 1 }; }, () => time);
  await report(session(), body());
  assert.equal((await report(session(), body())).skipped, 'duplicate');
  assert.equal((await report(session(), body(2))).skipped, 'throttled');
  await report(session('456'), body()); assert.equal(calls, 2);
  time = 10001; await report(session(), body(2)); assert.equal(calls, 3);
});
test('并发请求在await之前锁定，慢请求超过10秒仍不能重入', async () => {
  let time = 0, finish, calls = 0;
  const report = createHistoryReporter(() => { calls++; return new Promise((r) => finish = r); }, () => time);
  const pending = report(session(), body()); time = 20000;
  assert.equal((await report(session(), body())).skipped, 'duplicate');
  assert.equal((await report(session(), body(2))).skipped, 'throttled');
  finish({ status: 1 }); await pending; assert.equal(calls, 1);
});
test('上游超时不重发相同轮次，防止重复记账', async () => {
  let calls = 0;
  const report = createHistoryReporter(async () => { calls++; throw new Error('timeout'); });
  await assert.rejects(report(session(), body()), /timeout/);
  assert.equal((await report(session(), body())).skipped, 'duplicate');
  assert.equal(calls, 1);
});
test('拒绝匿名、任意歌曲、hash不符、未检查和无完整播放资格', async () => {
  let calls = 0;
  const report = createHistoryReporter(async () => calls++);
  const anonymous = session(); anonymous.user = null;
  await assert.rejects(report(anonymous, body()), { status: 401 });
  await assert.rejects(report(session(), { ...body(), songId: 'other' }), { status: 404 });
  await assert.rejects(report(session(), { ...body(), hash: 'b'.repeat(32) }), { status: 404 });
  for (const update of [{ checked: false }, { eligible: false }, { playbackState: 'unknown' }]) {
    const s = session(); Object.assign(s.tracks.get(body().songId), update);
    await assert.rejects(report(s, body()), { status: 403 });
  }
  assert.equal(calls, 0);
});
test('缺少有效MixSongID时跳过，不将内部组合ID当数字', async () => {
  let calls = 0; const report = createHistoryReporter(async () => calls++);
  const s = session(); s.tracks.get(body().songId).albumAudioId = '321:hash';
  assert.equal((await report(s, body())).skipped, 'missing_platform_id'); assert.equal(calls, 0);
});
test('上报JSON解析限制大小、类型和结构', async () => {
  const req = (text, type = 'application/json') => Object.assign(Readable.from([Buffer.from(text)]), { headers: { 'content-type': type } });
  assert.deepEqual(await readHistoryBody(req(JSON.stringify(body()))), body());
  await assert.rejects(readHistoryBody(req('{}', 'text/plain')), { status: 415 });
  await assert.rejects(readHistoryBody(req('[')), { status: 400 });
  await assert.rejects(readHistoryBody(req('[]')), { status: 400 });
  await assert.rejects(readHistoryBody(req(' '.repeat(2049))), { status: 413 });
});
test('平台返回缺失或失败状态时不冒充已接受，本轮不重试', async () => {
  for (const response of [undefined, {}, { status: 0 }, { status: '0' }, { status: 1, error_code: 2 }]) {
    let calls = 0;
    const report = createHistoryReporter(async () => { calls++; return response; });
    await assert.rejects(report(session(), body()), { status: 502 });
    assert.equal((await report(session(), body())).skipped, 'duplicate');
    assert.equal(calls, 1);
  }
});

test('音源版本与歌曲不一致时不能上报原MixSongID', async () => {
  const s = session();
  s.tracks.get(body().songId).playbackIdentity = { albumAudioId: 999 };
  let calls = 0;
  const report = createHistoryReporter(async () => { calls++; return { status: 1 }; });
  await assert.rejects(report(s, body()), { status: 403 });
  assert.equal(calls, 0);
});
