/* 自动检查：账号权益分类：版本精确匹配、购买接口失败、会员有效性和平台未上架。
 * 使用 Node 内置 node:test 与 assert；每个中文 test 标题说明场景，assert 是预期结果。
 * 桩数据用于可重复的本地验证，不代表平台当次真实权益；运行 node --test test/*.test.mjs。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPurchase, classify } from '../lib/entitlements.mjs';
test('购买的歌曲可按准确版本匹配，不依赖播放地址', () =>
  assert.ok(matchPurchase({ album_audio_id: 123 }, [{ album_audio_id: 123 }])));
test('同名的另一版本不得被误认为已购买', () =>
  assert.equal(
    matchPurchase({ album_audio_id: 124, name: '同名歌' }, [
      { album_audio_id: 123, name: '同名歌' },
    ]),
    undefined,
  ));
test('缺失标识和零值不能让全部歌曲匹配', () =>
  assert.equal(matchPurchase({ album_audio_id: 0 }, [{ album_audio_id: 0 }]), undefined));
test('hash 比较忽略大小写', () =>
  assert.ok(matchPurchase({ hash: 'ABC' }, [{ hash: 'abc' }])));
test('音源暂不可取也不应撤销已购歌曲的入选资格', () => {
  const result = classify(
    { albumAudioId: 123 },
    { album_audio_id: 123, status: 0, quality: '128', privilege: 10 },
    { songs: [{ album_audio_id: 123 }] },
  );
  assert.equal(result.eligible, true);
  assert.equal(result.entitlement, 'purchased');
});
test('购买接口报错时不应误判用户没有购买', () => {
  const result = classify({ albumAudioId: 123 }, undefined, {
    errors: ['lookup failed'],
  });
  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /读取失败/);
});
test('会员过期且平台未授权不能直接入选', () =>
  assert.equal(
    classify({}, { quality: '128', status: 0, privilege: 10 }, { vip: { is_vip: 0 } })
      .eligible,
    false,
  ));
test('平台明确未上架的版本与购买资格分开处理', () =>
  assert.equal(
    classify(
      { albumAudioId: 123 },
      { album_audio_id: 123, publish: 0 },
      { songs: [{ album_audio_id: 123 }] },
    ).state,
    'unavailable',
  ));
test('会员有效与资源存在不能证明单独付费版本被会员覆盖', () =>
  assert.equal(
    classify(
      {},
      { quality: '128', status: 1, pay_type: 3, price: 200 },
      { vip: { is_vip: '1' } },
    ).entitlement,
    'unknown',
  ));
test('已购专辑只覆盖相同专辑标识', () => {
  assert.equal(
    classify({ albumId: 5 }, undefined, { albums: [{ album_id: 5 }] }).entitlement,
    'purchased',
  );
  assert.equal(
    classify({ albumId: 6 }, undefined, { albums: [{ album_id: 5 }] }).eligible,
    false,
  );
});
test('权益接口给出另一专辑版本时不覆盖歌单版本的购买标识', () =>
  assert.equal(
    classify(
      { albumAudioId: 124, albumId: 6 },
      { album_audio_id: 123, album_id: 5 },
      { songs: [{ album_audio_id: 123 }], albums: [{ album_id: 5 }] },
    ).eligible,
    false,
  ));
test('损坏的相关音质字段不会阻断已购记录匹配', () =>
  assert.equal(
    classify(
      { albumAudioId: 123 },
      { relate_goods: {} },
      { songs: [{ album_audio_id: 123 }] },
    ).entitlement,
    'purchased',
  ));
test('字符串未上架标记也应排除该版本', () =>
  assert.equal(classify({}, { publish: '0' }, {}).state, 'unavailable'));
