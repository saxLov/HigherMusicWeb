import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/entitlements.mjs';
import { createAccessChecker } from '../lib/access.mjs';
import { createInspector } from '../lib/inspection.mjs';

const track = { hash: 'abc', albumAudioId: 123, albumId: 5, duration: 180 };
function fixture(overrides = {}) {
  return async (_session, name, params) => {
    if (overrides[name]) return overrides[name](params);
    if (name.startsWith('user_purchased')) return { data: [] };
    if (name === 'user_vip_detail') return { data: { is_vip: 0 } };
    if (name === 'privilege_lite') return { data: [] };
    if (name === 'song_url') return { data: { url: 'https://example.com/full', timeLength: 180 } };
    throw new Error(name);
  };
}

test('付费资源status=1不提升权益，VIP状态也不覆盖未知的单曲付费规则', () => {
  const resource = { hash: 'abc', quality: '128', status: 1, privilege: 10, pay_type: 3, price: 200 };
  for (const vip of [{ is_vip: 0 }, { is_vip: 1 }, { is_vip: '1' }]) {
    const result = classify(track, resource, { vip });
    assert.equal(result.state, 'unknown');
    assert.equal(result.eligible, false);
  }
});
test('损坏的购买列表记录不会阻断其他明确购买证据', () => {
  assert.equal(classify(track, undefined, {
    songs: [null, false, { album_audio_id: 123 }], albums: [null],
  }).entitlement, 'purchased');
  assert.equal(classify(track, undefined, {
    songs: [null], albums: [null, { album_id: 5 }],
  }).entitlement, 'purchased');
});

test('免费必须有明确字段，null或空串不会被Number转换成免费证据', () => {
  const resource = { quality: '128', status: 1, privilege: 0, pay_type: 0, price: 0 };
  assert.equal(classify(track, resource, {}).entitlement, 'free');
  for (const key of ['privilege', 'pay_type', 'price']) {
    for (const value of [null, undefined, '', false, true]) {
      assert.equal(classify(track, { ...resource, [key]: value }, {}).eligible, false);
    }
  }
});

test('权益查询失败，即使完整音源可取也保持权益待确认并拒绝进入画廊', async () => {
  const check = createAccessChecker(fixture({ privilege_lite: () => { throw new Error('temporary'); } }));
  const result = await check({}, track, true);
  assert.equal(result.playbackState, 'allowed');
  assert.equal(result.eligibilityState, 'unknown');
  assert.equal(result.state, 'unknown');
  assert.equal(result.eligible, false);
  assert.equal((await createInspector(check)({}, track)).playable, false);
});

test('关联音源不能借用另一MixSongID或专辑；合法同版本候选返回最终标识', async () => {
  const attempts = [];
  const check = createAccessChecker(fixture({
    user_purchased_songs: () => ({ data: [{ album_audio_id: 123 }] }),
    privilege_lite: () => ({ data: [{ hash: 'abc', album_audio_id: 123, album_id: 5,
      relate_goods: [
        { quality: '128', hash: 'other-recording', album_audio_id: 999 },
        { quality: '128', hash: 'other-album', album_id: 99 },
        { quality: '128', hash: 'same-version' },
      ],
    }] }),
    song_url: (params) => {
      attempts.push(params.hash);
      return params.hash === 'same-version' ? { url: 'https://example.com/a', timeLength: 180 } : {};
    },
  }));
  const result = await check({}, track, true);
  assert.deepEqual(attempts, ['abc', 'same-version']);
  assert.equal(result.state, 'allowed');
  assert.deepEqual(result.playbackIdentity, { hash: 'same-version', albumId: 5, albumAudioId: 123 });
});

test('实际音源明确返回另一版本时拒绝播放，已购权益仍保留', async () => {
  const check = createAccessChecker(fixture({
    user_purchased_songs: () => ({ data: [{ album_audio_id: 123 }] }),
    song_url: () => ({ data: { album_audio_id: 999, url: 'https://example.com/a', timeLength: 180 } }),
  }));
  const result = await check({}, track, true);
  assert.equal(result.eligible, true);
  assert.equal(result.state, 'unknown');
  assert.match(result.playbackReason, /版本/);
});

test('主动重新检查首项刷新账号权益，其余检查复用新缓存', async () => {
  let bought = false, reads = 0;
  const check = createAccessChecker(fixture({ user_purchased_songs: () => {
    reads++;
    return { data: bought ? [{ album_audio_id: 123 }] : [] };
  } }));
  const inspect = createInspector(check), session = {};
  assert.equal((await inspect(session, track)).eligible, false);
  bought = true;
  assert.equal((await inspect(session, track, true, true)).eligible, true);
  await inspect(session, track, true);
  assert.equal(reads, 2);
});
