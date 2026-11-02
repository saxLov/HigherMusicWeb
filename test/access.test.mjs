/* 自动检查：权益检查编排：购买分页、账号缓存、相关版本和真实完整音源不能互相冒充。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessChecker } from '../lib/access.mjs';

const track = { hash: 'abc', albumAudioId: 123, albumId: 5, duration: 240 };
/* 平台接口桩：默认提供可控响应，overrides 只替换当前场景关注的接口。 */
function provider(overrides = {}) {
  return async (s, name, params) => {
    if (overrides[name]) return overrides[name](params, s);
    if (name === 'user_purchased_songs' || name === 'user_purchased_albums')
      return { data: { total: 0, info: [] } };
    if (name === 'user_vip_detail') return { data: { is_vip: 0 } };
    if (name === 'privilege_lite')
      return { data: [{ hash: 'abc', album_audio_id: 123, quality: '128', status: 0 }] };
    if (name === 'song_url') return {};
    throw new Error('unexpected request: ' + name);
  };
}
test('已购歌曲即使没有音源也保留权益，播放结果不冒充成功', async () => {
  const check = createAccessChecker(
    provider({
      user_purchased_songs: () => ({ data: { info: [{ album_audio_id: 123 }] } }),
    }),
  );
  const result = await check({}, track, true);
  assert.equal(result.eligible, true);
  assert.equal(result.entitlement, 'purchased');
  assert.equal(result.eligibilityState, 'allowed');
  assert.equal(result.state, 'unknown');
  assert.equal(result.canAttempt, false);
});
test('只有试听地址时也不能将已购歌曲的播放标为完整', async () => {
  const check = createAccessChecker(
    provider({
      user_purchased_songs: () => ({ data: { info: [{ album_audio_id: 123 }] } }),
      song_url: () => ({
        url: ['https://example.com/preview'],
        timeLength: 30,
        is_free_part: 1,
      }),
    }),
  );
  const result = await check({}, track, true);
  assert.equal(result.eligible, true);
  assert.equal(result.playbackState, 'blocked');
  assert.equal(result.canAttempt, false);
});
test('已购记录第二页命中，不因平台每页上限而漏掉', async () => {
  const check = createAccessChecker(
    provider({
      user_purchased_songs: ({ page }) => ({
        data: { total: 2, info: [{ album_audio_id: page === 1 ? 99 : 123 }] },
      }),
    }),
  );
  assert.equal((await check({}, track)).entitlement, 'purchased');
});
test('权益接口返回另一首歌曲时不能借用它的免费状态', async () => {
  const check = createAccessChecker(
    provider({
      privilege_lite: () => ({
        data: [{ hash: 'different', quality: '128', status: 1, pay_type: 0, price: 0 }],
      }),
    }),
  );
  assert.equal((await check({}, track)).eligible, false);
});
test('会员有效但单曲未获平台授权时不能仅凭会员入选', async () => {
  const check = createAccessChecker(
    provider({ user_vip_detail: () => ({ data: { is_vip: 1 } }) }),
  );
  assert.equal((await check({}, track)).eligible, false);
});
test('相关音质缺少专辑标识时沿用当前版本再请求', async () => {
  const attempts = [];
  const check = createAccessChecker(
    provider({
      privilege_lite: () => ({
        data: [
          {
            hash: 'abc',
            album_id: 5,
            album_audio_id: 123,
            relate_goods: [{ quality: '128', hash: 'backup' }],
          },
        ],
      }),
      song_url: (params) => {
        attempts.push(params);
        return params.hash === 'backup'
          ? { url: ['https://example.com/full'], timeLength: 240 }
          : {};
      },
    }),
  );
  assert.equal((await check({}, track, true)).state, 'allowed');
  assert.equal(attempts[1].album_audio_id, 123);
  assert.equal(attempts[1].album_id, 5);
});
test('暂时失败的购买查询很快重试，成功后恢复真实购买分类', async () => {
  let clock = 0;
  let attempts = 0;
  const session = {};
  const check = createAccessChecker(
    provider({
      user_purchased_songs: () => {
        attempts++;
        if (attempts === 1) throw new Error('temporary');
        return { data: { info: [{ album_audio_id: 123 }] } };
      },
    }),
    () => clock,
  );
  assert.equal((await check(session, track)).state, 'unknown');
  clock = 5000;
  await check(session, track);
  assert.equal(attempts, 1);
  clock = 10001;
  assert.equal((await check(session, track)).entitlement, 'purchased');
  assert.equal(attempts, 2);
});
test('账号间不能复用购买查询缓存', async () => {
  const check = createAccessChecker(
    provider({
      user_purchased_songs: (_params, s) => ({
        data: { info: s.owner ? [{ album_audio_id: 123 }] : [] },
      }),
    }),
  );
  assert.equal((await check({ owner: true }, track)).eligible, true);
  assert.equal((await check({ owner: false }, track)).eligible, false);
});
test('不完整购买分页不会作为完整的空购买列表缓存', async () => {
  const check = createAccessChecker(
    provider({
      user_purchased_songs: () => ({
        data: { total: 100, info: [{ album_audio_id: 99 }] },
      }),
    }),
  );
  const result = await check({}, track);
  assert.equal(result.state, 'unknown');
  assert.match(result.accountWarnings[0], /重复/);
});
