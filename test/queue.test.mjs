/* 自动检查：独立队列模型：顺序终止、单曲循环、随机不重复及真实历史回退。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackQueue } from '../public/queue.mjs';

test('顺序播放只按入选队列推进，到末尾停止', () => {
  const q = new PlaybackQueue();
  q.select('a');
  assert.equal(q.next(['a', 'c'], 'a', { ended: true }), 'c');
  assert.equal(q.next(['a', 'c'], 'c', { ended: true }), null);
  assert.equal(q.previous(['a', 'c'], 'c'), 'a');
});
test('单曲循环在自然结束时重播，手动下一首仍可切歌', () => {
  const q = new PlaybackQueue();
  q.setMode('single');
  q.select('a');
  assert.equal(q.next(['a', 'b'], 'a', { ended: true }), 'a');
  assert.equal(q.next(['a', 'b'], 'a'), 'b');
  assert.equal(q.next(['b'], 'a', { ended: true }), null);
});
test('随机播放一轮内不重复且不立即重播当前歌曲', () => {
  const q = new PlaybackQueue(() => 0);
  q.setMode('shuffle');
  q.select('a');
  let current = 'a';
  const played = [];
  for (let i = 0; i < 3; i++) {
    current = q.next(['a', 'b', 'c', 'd'], current);
    q.select(current);
    played.push(current);
  }
  assert.deepEqual(played, ['b', 'c', 'd']);
  assert.notEqual(q.next(['a', 'b', 'c', 'd'], current), current);
});
test('随机模式上一首沿真实历史，下一首可回到刚才的歌曲', () => {
  const q = new PlaybackQueue(() => 0);
  q.setMode('shuffle');
  q.select('a');
  q.select('c');
  q.select('b');
  assert.equal(q.previous(['a', 'b', 'c'], 'b'), 'c');
  q.select('c');
  assert.equal(q.next(['a', 'b', 'c'], 'c'), 'b');
});
test('权限变化后随机队列剔除已失效歌曲', () => {
  const q = new PlaybackQueue(() => 0);
  q.setMode('shuffle');
  q.select('a');
  const first = q.next(['a', 'b', 'c'], 'a');
  q.select(first);
  assert.equal(q.next(['a', 'b'], first), 'a');
});
test('空队列停止，单首随机可重播，换歌单清除历史', () => {
  const q = new PlaybackQueue();
  q.setMode('shuffle');
  q.select('a');
  assert.equal(q.next([], 'a'), null);
  assert.equal(q.next(['a'], 'a'), 'a');
  q.reset();
  assert.equal(q.previous(['a', 'b'], 'b'), null);
  assert.equal(q.mode, 'shuffle');
});
