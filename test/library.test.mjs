/* 自动检查：会话歌曲库：跨歌单去重、检查结果保留与本地虚拟歌单，不修改平台数据。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTracks,
  recordAccess,
  unauthorizedTracks,
  localPlaylist,
} from '../lib/library.mjs';

const session = () => ({ tracks: new Map() });
const row = (id, hash = id) => ({ id, hash, title: id, state: 'unchecked' });
const unknown = {
  state: 'unknown',
  eligible: false,
  reason: '待确认',
  playbackState: 'unknown',
};
const allowed = {
  state: 'allowed',
  eligible: true,
  entitlement: 'purchased',
  reason: '已购',
  playbackState: 'unknown',
};
test('检查后创建未授权歌单，仅收集未入选的已检查歌曲', () => {
  const s = session();
  const [a, b] = registerTracks(s, 'p', [row('a'), row('b'), row('c')]);
  assert.equal(localPlaylist(s), null);
  recordAccess(s, a, unknown);
  recordAccess(s, b, allowed);
  assert.equal(localPlaylist(s).name, '未授权的音乐');
  assert.deepEqual(
    unauthorizedTracks(s).map((t) => t.title),
    ['a'],
  );
  assert.equal(s.library.get('p').length, 3);
});
test('重试通过后移出未授权歌单，已购无音源也不放入其中', () => {
  const s = session();
  const [a] = registerTracks(s, 'p', [row('a')]);
  recordAccess(s, a, unknown);
  assert.equal(unauthorizedTracks(s).length, 1);
  recordAccess(s, a, { ...allowed, eligibilityState: 'allowed', state: 'unknown' });
  assert.equal(unauthorizedTracks(s).length, 0);
  assert.equal(localPlaylist(s).count, 0);
});
test('多个原歌单同版本去重，保留各原歌单并同步结果', () => {
  const s = session();
  registerTracks(s, 'p', [row('a')]);
  const [a] = registerTracks(s, 'other', [row('a')]);
  recordAccess(s, a, unknown);
  assert.equal(unauthorizedTracks(s).length, 1);
  assert.equal(s.library.get('p')[0].checked, true);
  recordAccess(s, a, allowed);
  assert.equal(s.library.get('p')[0].eligible, true);
});
test('歌单重新读取不会丢失之前的权限检查结果', () => {
  const s = session();
  const [a] = registerTracks(s, 'p', [row('a')]);
  recordAccess(s, a, unknown);
  registerTracks(s, 'p', [row('a')]);
  assert.equal(localPlaylist(s).count, 1);
});
test('账号独立，切换原歌单后仍能找到本账号未授权歌曲', () => {
  const a = session();
  const b = session();
  const [t] = registerTracks(a, 'p', [row('a')]);
  recordAccess(a, t, unknown);
  registerTracks(a, 'other', [row('b')]);
  assert.equal(unauthorizedTracks(a).length, 1);
  assert.equal(localPlaylist(b), null);
  assert.equal(unauthorizedTracks(b).length, 0);
});
test('不同文件版本不去重，平台未上架保留明确原因', () => {
  const s = session();
  const [a, b] = registerTracks(s, 'p', [row('same', 'hash1'), row('same', 'hash2')]);
  recordAccess(s, a, unknown);
  recordAccess(s, b, { state: 'unavailable', eligible: false, reason: '平台未上架' });
  assert.equal(unauthorizedTracks(s).length, 2);
  assert.equal(unauthorizedTracks(s)[1].reason, '平台未上架');
});
