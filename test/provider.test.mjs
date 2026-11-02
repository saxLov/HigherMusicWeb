/* 自动检查：平台数据适配：不同列表字段、未知结构与毫秒时长规范化。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listFrom, normalizeTrack } from '../lib/provider.mjs';
test('私人歌单接口 file 数组可以读取', () =>
  assert.equal(listFrom({ data: { file: [{ filename: 'test' }] } }).length, 1));
test('空歌单和未知格式区别处理', () => {
  assert.deepEqual(listFrom({ data: { file: [] } }), []);
  assert.throws(() => listFrom({ data: { unexpected: 1 } }), /格式/);
});
test('歌单毫秒时长规范化', () =>
  assert.equal(
    normalizeTrack({ fileinfo: { hash: 'test', filename: 'test', timelen: 196000 } })
      .duration,
    196,
  ));
