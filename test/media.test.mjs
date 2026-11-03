/* 自动检查：媒体加载工具：playing 事件、取消、备用线路、超时与自动播放拒绝。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAudio } from '../public/media.mjs';
/* 模拟媒体事件的播放器；测试主动派发 playing/error，不会连接真实音源。 */
class AudioStub extends EventTarget {
  duration = 240;
  pause() {}
  play() {
    return Promise.resolve();
  }
}
test('调用 play 成功不代表开始播放，必须收到 playing', async () => {
  const audio = new AudioStub();
  let done = false;
  const result = loadAudio(
    audio,
    'https://example.com/a',
    new AbortController().signal,
  ).then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  audio.dispatchEvent(new Event('playing'));
  await result;
  assert.equal(done, true);
});
test('切歌取消后，旧音源的迟到 playing 不能变为成功', async () => {
  const audio = new AudioStub();
  const controller = new AbortController();
  const result = loadAudio(audio, 'https://example.com/a', controller.signal);
  controller.abort();
  audio.dispatchEvent(new Event('playing'));
  await assert.rejects(result, { name: 'AbortError' });
});
test('失败线路结束，备用线路可独立加载', async () => {
  const audio = new AudioStub();
  const first = loadAudio(audio, 'https://example.com/a', new AbortController().signal);
  audio.dispatchEvent(new Event('error'));
  await assert.rejects(first, /加载失败/);
  const second = loadAudio(audio, 'https://example.com/b', new AbortController().signal);
  audio.dispatchEvent(new Event('playing'));
  await second;
  assert.equal(audio.src, 'https://example.com/b');
});
test('加载永不完成时按时退出', async () => {
  await assert.rejects(
    loadAudio(new AudioStub(), 'https://example.com/a', new AbortController().signal, 10),
    /超时/,
  );
});
test('浏览器禁止自动播放时保留明确错误', async () => {
  const audio = new AudioStub();
  audio.play = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  await assert.rejects(
    loadAudio(audio, 'https://example.com/a', new AbortController().signal),
    { name: 'NotAllowedError' },
  );
});
test('实际音频短于预期时即使playing也拒绝，并清理本次监听', async () => {
  const audio = new AudioStub(); audio.duration = 30;
  const result = loadAudio(audio, 'https://example.com/preview', new AbortController().signal, 15000, 240);
  audio.dispatchEvent(new Event('playing'));
  await assert.rejects(result, /不完整/);
  audio.duration = 240;
  const next = loadAudio(audio, 'https://example.com/full', new AbortController().signal, 15000, 240);
  audio.dispatchEvent(new Event('loadedmetadata')); audio.dispatchEvent(new Event('playing'));
  await next;
});
