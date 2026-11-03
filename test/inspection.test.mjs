import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInspector } from '../lib/inspection.mjs';
test('批量检查仅返回摘要，不泄露音源、不签发票据；会话隔离且主动复查绕过缓存', async () => {
  let time = 0, calls = 0;
  const inspect = createInspector(async () => { calls++; return { state: 'allowed', playbackState: 'allowed', url: 'https://example.com/private', urls: ['https://example.com/private'] }; }, () => time);
  const s = {}, track = { id: 'a' };
  const result = await inspect(s, track);
  assert.deepEqual(result, { state: 'allowed', playbackState: 'allowed', playable: true });
  assert.equal(s.media, undefined);
  await inspect(s, track); assert.equal(calls, 1);
  await inspect(s, track, true); assert.equal(calls, 2);
  await inspect({}, track); assert.equal(calls, 3);
  time = 30001; await inspect(s, track); assert.equal(calls, 4);
});
test('试听、待确认或无音源不能成为可播放摘要', async () => {
  for (const value of [
    { state: 'unknown', playbackState: 'allowed', url: 'https://example.com/a' },
    { state: 'allowed', playbackState: 'blocked', url: 'https://example.com/a' },
    { state: 'allowed', playbackState: 'allowed' },
  ]) {
    const result = await createInspector(async () => value)({}, { id: 'a' });
    assert.equal(result.playable, false); assert.equal(result.url, undefined);
  }
});
