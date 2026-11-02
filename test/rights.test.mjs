/* 自动检查：音源完整性：试听标识、主备 URL、HTTPS 升级、参考时长缺失和短片段拒绝。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePlayback } from '../lib/rights.mjs';
test('试听即使带有音源地址也不能通过', () =>
  assert.equal(
    evaluatePlayback(
      { url: ['https://example.com/a.mp3'], timeLength: 240, is_free_part: 1 },
      { duration: 240 },
    ).state,
    'blocked',
  ));
test('短片段不能冒充整首歌曲', () =>
  assert.equal(
    evaluatePlayback(
      { url: ['https://example.com/a.mp3'], timeLength: 30 },
      { duration: 240 },
    ).state,
    'blocked',
  ));
test('缺少完整性证据保持待确认', () =>
  assert.equal(
    evaluatePlayback({ url: ['https://example.com/a.mp3'] }, { duration: 240 }).state,
    'unknown',
  ));
test('没有可用音源保持待确认', () =>
  assert.equal(evaluatePlayback({ status: 1 }, { duration: 240 }).state, 'unknown'));
test('完整音源可以通过，支持毫秒长度', () =>
  assert.equal(
    evaluatePlayback(
      { url: ['https://example.com/a.mp3'], timeLength: 240000 },
      { duration: 240 },
    ).state,
    'allowed',
  ));
test('拒绝非 HTTPS 音源', () =>
  assert.equal(
    evaluatePlayback({ url: ['javascript:alert(1)'], timeLength: 240 }, { duration: 240 })
      .state,
    'unknown',
  ));
test('平台 HTTP CDN 地址升级为 HTTPS', () =>
  assert.equal(
    evaluatePlayback(
      { url: ['http://example.com/a.mp3'], timeLength: 240 },
      { duration: 240 },
    ).url,
    'https://example.com/a.mp3',
  ));
test('主线路为空时仍保留平台备用音源', () =>
  assert.deepEqual(
    evaluatePlayback(
      { url: [], backupUrl: ['http://example.com/b.mp3'], timeLength: 240 },
      { duration: 240 },
    ).urls,
    ['https://example.com/b.mp3'],
  ));
test('主备线路去重并拒绝无效协议', () =>
  assert.deepEqual(
    evaluatePlayback(
      {
        url: ['http://example.com/a.mp3'],
        backupUrl: [
          'https://example.com/a.mp3',
          'javascript:bad',
          'https://example.com/b.mp3',
        ],
        timeLength: 240,
      },
      { duration: 240 },
    ).urls,
    ['https://example.com/a.mp3', 'https://example.com/b.mp3'],
  ));
test('Brave Shine 回归：歌单缺少时长但音源返回完整时长，不应拒绝播放', () => {
  const result = evaluatePlayback(
    { url: ['http://example.com/brave.mp3'], timeLength: 261 },
    { duration: 0 },
  );
  assert.equal(result.state, 'allowed');
  assert.equal(result.expectedDuration, 261);
});
test('返回时长缺失时保留音源供浏览器按歌单时长校验', () => {
  const result = evaluatePlayback(
    { url: ['https://example.com/brave.mp3'] },
    { duration: 261 },
  );
  assert.equal(result.state, 'unknown');
  assert.equal(result.canAttempt, true);
  assert.equal(result.expectedDuration, 261);
});
test('两处均无时长不能确认为完整播放', () => {
  const result = evaluatePlayback(
    { url: ['https://example.com/brave.mp3'] },
    { duration: 0 },
  );
  assert.equal(result.state, 'unknown');
  assert.equal(result.canAttempt, false);
});
test('歌单没有时长也不能放过明确的试听标记', () =>
  assert.equal(
    evaluatePlayback(
      { url: ['https://example.com/brave.mp3'], timeLength: 60, is_free_part: 1 },
      { duration: 0 },
    ).state,
    'blocked',
  ));
test('无效时长数值不能被当成完整性证据', () =>
  assert.equal(
    evaluatePlayback(
      { url: ['https://example.com/a.mp3'], timeLength: 'bad' },
      { duration: NaN },
    ).canAttempt,
    false,
  ));
